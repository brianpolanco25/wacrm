// ============================================================
// `Idempotency-Key` for the public API (fase 7 §1).
//
// The contract, from the caller's side:
//
//   POST /api/v1/messages
//   Idempotency-Key: 8f3c…            (1–255 chars, the client's choice)
//
//   • first call            → the handler runs, the response is stored
//   • same key, same body   → the STORED response, plus
//                             `Idempotent-Replayed: true`. Nothing runs
//                             twice; no second message is sent.
//   • same key, other body  → 409 `idempotency_mismatch`
//   • same key, still running → 409 `conflict`
//   • no key                → nothing is stored, business as usual
//   • after 24 h            → the key is free again
//
// How the "still running" case is caught, and why it matters
//   The reservation is an INSERT against the UNIQUE index
//   `(api_key_id, idempotency_key)` from migration 061, made BEFORE the
//   handler runs and with `response_status` still NULL. Two concurrent
//   retries therefore race in the database, not in Node: exactly one
//   INSERT succeeds and does the work; the loser sees the unique
//   violation, finds a row with no response yet, and gets a 409 instead
//   of sending the same WhatsApp message a second time. A check-then-act
//   in application code would not survive that race.
//
// What gets stored, and what does not
//   Only 2xx responses. A 400/429/500 releases the key, so a client that
//   fixes a malformed payload can retry with the same id instead of
//   being locked out for 24 h — and a transient 500 does not freeze a
//   failure in amber. The cost is that an error is not replayed
//   verbatim; the benefit is that a key never becomes a tombstone.
//
// The hash covers method + path + QUERY STRING + raw body
//   Reusing one key across two different endpoints is a client bug, and
//   it surfaces as `idempotency_mismatch` rather than as one endpoint
//   quietly answering with the other's payload. The query string is in
//   there on purpose: a future write whose behaviour varies by
//   parameter (`?dry_run=1`, `?format=csv`) must not replay the other
//   variant's stored response. Two calls that differ only in the query
//   get `idempotency_mismatch`, which is the honest answer.
//
// A reservation that never finishes
//   If the process dies between the INSERT and the response, the row
//   stays with `response_status` NULL and nobody will ever fill it.
//   Leaving it there would poison the key for the full 24 h TTL while
//   telling the caller something is "still in progress". So an
//   unfinished reservation older than `IN_FLIGHT_STALE_MS` is treated
//   as abandoned: it is deleted (only if it is STILL unfinished) and
//   the slot re-reserved. The window is deliberately several times the
//   longest handler we allow (`maxDuration = 60` on broadcasts), so a
//   genuinely running request is never stolen from. What this trades
//   away: a crash in the narrow gap between the side effect and the
//   store leaves a request that DID happen looking abandoned, and a
//   retry after the window will happen again. That is the same
//   exposure as any client whose connection drops mid-write, and it is
//   bounded; a key that is dead for 24 h is not.
//
// Reuse: every future v1 write (tags a7.2, templates a7.3, exports
// a7.5) gets this by wrapping its handler — it is the only place that
// should call `readJsonBody` for a write with side effects.
// ============================================================

import { createHash } from 'node:crypto';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApiKeyContext } from '@/lib/auth/api-context';
import { readJsonBody } from '@/lib/api/v1/body';
import {
  badRequest,
  conflict,
  idempotencyMismatch,
  replayed,
} from '@/lib/api/v1/respond';

/** Header the caller sends. Matched case-insensitively by `Headers`. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Bounds from the spec: a key is 1–255 characters. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** How long a stored response stays replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * After this long with no response recorded, a reservation is assumed
 * abandoned (the process that made it died) and can be taken over.
 * Two minutes is twice the longest handler the app allows — the 60 s
 * `maxDuration` of `POST /api/v1/broadcasts` — so a request that is
 * really still running is never displaced.
 */
export const IN_FLIGHT_STALE_MS = 2 * 60 * 1000;

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * Expired rows are never *read* (every lookup filters on `expires_at`),
 * so purging is housekeeping, not correctness. Doing it 1-in-N keeps it
 * off the hot path — same trick as the rate limiter's light sweep.
 */
const PURGE_EVERY = 100;
let callsSincePurge = 0;

interface IdempotencyRow {
  id: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  created_at: string;
  expires_at: string;
}

/**
 * Stable digest of "which request is this". `path` must include the
 * query string: see the header note — a write that varies by parameter
 * would otherwise replay the other variant's response.
 */
function hashRequest(method: string, path: string, rawBody: string): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${rawBody}`)
    .digest('hex');
}

/**
 * Re-read a handler's response so we can store it, and hand back an
 * equivalent one (a body can only be consumed once). Status, headers
 * and bytes are preserved exactly — including the `X-Request-Id` the
 * original response minted.
 */
async function captureJson(
  response: NextResponse
): Promise<{ json: unknown; response: NextResponse }> {
  if (!response.body) return { json: null, response };
  const text = await response.text();
  const rebuilt = new NextResponse(text, {
    status: response.status,
    headers: response.headers,
  });
  try {
    return { json: JSON.parse(text) as unknown, response: rebuilt };
  } catch {
    // Not JSON (no v1 route does this today). Storing nothing means the
    // retry re-runs; that is the safe direction for a body we cannot
    // faithfully reproduce.
    return { json: undefined, response: rebuilt };
  }
}

/** Best-effort removal of this account's expired rows. Never throws. */
function purgeExpired(db: SupabaseClient, accountId: string): void {
  callsSincePurge += 1;
  if (callsSincePurge < PURGE_EVERY) return;
  callsSincePurge = 0;
  void db
    .from('api_idempotency_keys')
    .delete()
    .eq('account_id', accountId)
    .lt('expires_at', new Date().toISOString())
    .then(({ error }) => {
      if (error) {
        console.warn('[api/v1/idempotency] purge failed:', error.message);
      }
    });
}

async function findRow(
  ctx: ApiKeyContext,
  key: string
): Promise<IdempotencyRow | null> {
  // Scoped by account AND key (CP3). The unique index is per API key, so
  // two keys of the same account with the same `Idempotency-Key` keep
  // their own rows and never see each other's response.
  const { data, error } = await ctx.supabase
    .from('api_idempotency_keys')
    .select(
      'id, request_hash, response_status, response_body, created_at, expires_at'
    )
    .eq('account_id', ctx.accountId)
    .eq('api_key_id', ctx.keyId)
    .eq('idempotency_key', key)
    .maybeSingle();

  if (error) {
    console.error('[api/v1/idempotency] lookup failed:', error.message);
    return null;
  }
  return (data as IdempotencyRow | null) ?? null;
}

/**
 * Run a write endpoint under `Idempotency-Key`.
 *
 *   export async function POST(request: Request) {
 *     try {
 *       const ctx = await requireApiKey(request, 'messages:send');
 *       return await withIdempotency(ctx, request, async (body) => {
 *         …                       // returns a NextResponse
 *       });
 *     } catch (err) {
 *       return toApiErrorResponse(err);
 *     }
 *   }
 *
 * `handler` receives the parsed body (`readJsonBody` already enforced
 * `Content-Type`, the 1 MiB ceiling and "must be an object"), so a
 * route never touches `request.json()`. Anything the handler throws
 * propagates untouched after the reservation is released.
 */
export async function withIdempotency(
  ctx: ApiKeyContext,
  request: Request,
  handler: (body: Record<string, unknown>) => Promise<NextResponse>
): Promise<NextResponse> {
  const presented = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  const key = presented === null ? null : presented.trim();
  if (
    key !== null &&
    (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)
  ) {
    throw badRequest(
      `'${IDEMPOTENCY_KEY_HEADER}' must be between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
    );
  }

  const body = await readJsonBody(request);
  if (key === null) {
    // Opt-in feature: without the header the endpoint behaves exactly
    // as it did before, and nothing is written to the store.
    return handler(body.data);
  }

  const url = new URL(request.url);
  const requestHash = hashRequest(
    request.method,
    `${url.pathname}${url.search}`,
    body.raw
  );
  const now = Date.now();

  const reserve = async () =>
    ctx.supabase.from('api_idempotency_keys').insert({
      account_id: ctx.accountId,
      api_key_id: ctx.keyId,
      idempotency_key: key,
      request_hash: requestHash,
      expires_at: new Date(now + IDEMPOTENCY_TTL_MS).toISOString(),
    });

  let { error } = await reserve();

  if (error?.code === UNIQUE_VIOLATION) {
    const existing = await findRow(ctx, key);

    if (existing && new Date(existing.expires_at).getTime() <= now) {
      // The row is past its 24 h. Drop it and take the slot; if someone
      // else got there first we fall through to the conflict below.
      await ctx.supabase
        .from('api_idempotency_keys')
        .delete()
        .eq('account_id', ctx.accountId)
        .eq('id', existing.id);
      ({ error } = await reserve());
    } else if (existing) {
      if (existing.request_hash !== requestHash) {
        throw idempotencyMismatch(
          `This '${IDEMPOTENCY_KEY_HEADER}' was already used for a different request`
        );
      }
      if (existing.response_status !== null) {
        purgeExpired(ctx.supabase, ctx.accountId);
        return replayed(existing.response_body, existing.response_status);
      }

      // No response recorded yet: either a sibling request is running
      // right now, or the one that reserved this slot died. Tell them
      // apart by age (see the header note on abandoned reservations).
      const startedAt = new Date(existing.created_at).getTime();
      const abandoned =
        Number.isFinite(startedAt) && now - startedAt >= IN_FLIGHT_STALE_MS;

      if (!abandoned) {
        // Genuinely in flight. "In a moment" is honest here: the
        // handler either finishes or the row goes stale within
        // `IN_FLIGHT_STALE_MS`, never the 24 h of the TTL.
        throw conflict(
          `A request with this '${IDEMPOTENCY_KEY_HEADER}' is still in progress; retry in a moment`
        );
      }

      // Abandoned. Delete it ONLY while it is still unfinished
      // (`.is('response_status', null)`): if the original landed
      // between the read and here, the delete matches nothing, the
      // re-reservation loses on the unique index and the shared
      // conflict below answers. Taking the slot falls through to the
      // handler, which runs the work for real.
      await ctx.supabase
        .from('api_idempotency_keys')
        .delete()
        .eq('account_id', ctx.accountId)
        .eq('id', existing.id)
        .is('response_status', null);
      ({ error } = await reserve());
    }

    if (error) {
      // Lost the race twice (or the row vanished under us). Telling the
      // caller to retry is the only answer that cannot double-send.
      throw conflict(
        `A request with this '${IDEMPOTENCY_KEY_HEADER}' is still in progress; retry in a moment`
      );
    }
  } else if (error) {
    console.error('[api/v1/idempotency] reserve failed:', error.message);
    // The store is not the feature the caller asked for. Refusing the
    // write because bookkeeping is down would be worse than running it
    // without the replay guarantee.
    return handler(body.data);
  }

  const release = async () => {
    const { error: delError } = await ctx.supabase
      .from('api_idempotency_keys')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('api_key_id', ctx.keyId)
      .eq('idempotency_key', key);
    if (delError) {
      console.warn('[api/v1/idempotency] release failed:', delError.message);
    }
  };

  let response: NextResponse;
  try {
    response = await handler(body.data);
  } catch (err) {
    await release();
    throw err;
  }

  if (response.status < 200 || response.status >= 300) {
    await release();
    return response;
  }

  const captured = await captureJson(response);
  if (captured.json === undefined) {
    await release();
    return captured.response;
  }

  const { error: storeError } = await ctx.supabase
    .from('api_idempotency_keys')
    .update({
      response_status: response.status,
      response_body: captured.json,
    })
    .eq('account_id', ctx.accountId)
    .eq('api_key_id', ctx.keyId)
    .eq('idempotency_key', key);

  if (storeError) {
    // The work HAPPENED; only the memo failed. Releasing the key lets a
    // retry go through again (a duplicate), keeping it would make the
    // retry a permanent 409 (`conflict`) on work that succeeded. We keep
    // it: a stuck key expires in 24 h, a duplicate send does not.
    console.error(
      '[api/v1/idempotency] could not store response:',
      storeError.message
    );
  }

  purgeExpired(ctx.supabase, ctx.accountId);
  return captured.response;
}

/** Test-only: reset the purge counter so tests do not leak state. */
export function __resetIdempotencyPurgeCounter(): void {
  callsSincePurge = 0;
}
