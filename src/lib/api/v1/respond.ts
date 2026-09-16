// ============================================================
// Public API (v1) response envelope.
//
// Every `/api/v1/*` route speaks one shape so external integrators
// can write a single response parser:
//
//   success → { "data": <payload> }
//   failure → { "error": { "code": "<machine_code>", "message": "<human>" } }
//
// `code` is a stable, machine-matchable string (clients branch on
// it); `message` is human-facing and may be reworded freely. This is
// intentionally distinct from the internal `{ error: string }` shape
// used by the dashboard's own `/api/*` routes — the public contract
// is versioned and shouldn't inherit internal wording changes.
// ============================================================

import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';
import type { RateLimitResult } from '@/lib/rate-limit';
import { billingErrorPayload } from '@/lib/billing/enforce';

/**
 * Correlation id echoed on every `/api/v1` response and repeated inside
 * the error envelope as `request_id`. An integrator pastes it into a
 * support ticket and we can find the exact call in the logs.
 *
 * It is MINTED here, never read off the request. Echoing a
 * client-supplied `X-Request-Id` would let a caller forge or collide
 * ids in our logs (and smuggle arbitrary bytes into a response header);
 * the value is only useful if the server owns it.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Marks a response that was replayed from the idempotency store
 * instead of being produced by running the handler again. Only ever
 * set by {@link replayed} — one spelling, one place (fase 7 §1).
 */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * The headers every v1 response carries, plus the id that goes with
 * them. `no-store` because these payloads are account data behind a
 * bearer credential: no shared cache, no browser cache, no proxy copy.
 *
 * Every constructor in this file goes through here, so a route never
 * writes either header by hand and a new endpoint cannot forget them.
 */
export function v1Headers(extra?: Record<string, string>): {
  requestId: string;
  headers: Record<string, string>;
} {
  const requestId = randomUUID();
  return {
    requestId,
    headers: {
      'Cache-Control': 'no-store',
      [REQUEST_ID_HEADER]: requestId,
      ...extra,
    },
  };
}

export type ApiErrorCode =
  | 'unauthorized' // missing / malformed / unknown / revoked / expired key
  | 'forbidden' // valid key, but missing the required scope
  | 'rate_limited' // per-key budget exhausted
  | 'bad_request' // malformed input
  | 'not_found'
  | 'account_read_only' // subscription suspended/expired: reads only
  | 'feature_unavailable' // the plan does not include this endpoint
  | 'quota_exceeded' // monthly allowance spent
  | 'plan_limit_reached' // a stock limit (seats, numbers, documents) is full
  | 'conflict' // the resource is busy / in an incompatible state
  | 'idempotency_mismatch' // same Idempotency-Key, different request
  | 'payload_too_large' // body over the 1 MiB ceiling
  | 'unsupported_media_type' // write without `Content-Type: application/json`
  | 'internal';

/**
 * Typed error a route (or `requireApiKey`) can throw and have mapped
 * to the envelope by `toApiErrorResponse`. Carries an HTTP status, a
 * machine code, and optional extra headers (used for the rate-limit
 * `Retry-After` / `X-RateLimit-*` set).
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly headers?: Record<string, string>;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.headers = headers;
  }
}

/** 401 — no usable credential. */
export function unauthorized(message = 'Missing or invalid API key'): ApiError {
  return new ApiError('unauthorized', message, 401);
}

/** 403 — authenticated, but the key lacks the scope this route needs. */
export function forbidden(message: string): ApiError {
  return new ApiError('forbidden', message, 403);
}

/** 400 — bad input. */
export function badRequest(message: string): ApiError {
  return new ApiError('bad_request', message, 400);
}

/** 404 — no such resource *in this account* (never 403: see CP3). */
export function notFound(message = 'Not found'): ApiError {
  return new ApiError('not_found', message, 404);
}

/** 409 — the request collides with something already in flight. */
export function conflict(message: string): ApiError {
  return new ApiError('conflict', message, 409);
}

/** 409 — `Idempotency-Key` reused for a different request. */
export function idempotencyMismatch(message: string): ApiError {
  return new ApiError('idempotency_mismatch', message, 409);
}

/** 413 — body over the 1 MiB ceiling (see `src/lib/api/v1/body.ts`). */
export function payloadTooLarge(message: string): ApiError {
  return new ApiError('payload_too_large', message, 413);
}

/** 415 — a write without `Content-Type: application/json`. */
export function unsupportedMediaType(message: string): ApiError {
  return new ApiError('unsupported_media_type', message, 415);
}

/** 429 — built from a `checkRateLimit` miss, with the standard headers. */
export function rateLimited(result: RateLimitResult): ApiError {
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return new ApiError(
    'rate_limited',
    'Rate limit exceeded for this API key',
    429,
    {
      'Retry-After': String(retryAfter),
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
    }
  );
}

/** Success envelope: `{ data: <payload> }`. */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status, headers: v1Headers().headers });
}

/**
 * List envelope: `{ data: [...], meta: { next_cursor } }`. The `meta`
 * block is the pagination contract shared by every v1 list endpoint —
 * `next_cursor` is an opaque string to pass back as `?cursor=`, or
 * `null` on the last page. See `src/lib/api/v1/pagination.ts`.
 */
export function okList<T>(items: T[], nextCursor: string | null): NextResponse {
  return NextResponse.json(
    { data: items, meta: { next_cursor: nextCursor } },
    { headers: v1Headers().headers }
  );
}

/**
 * Rebuild a response that was stored by the idempotency layer. The body
 * and status are byte-for-byte what the original call returned; the
 * correlation id is FRESH (this is a different request) and
 * `Idempotent-Replayed: true` tells the caller nothing ran a second
 * time. See `src/lib/api/v1/idempotency.ts`.
 */
export function replayed(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: v1Headers({ [IDEMPOTENT_REPLAYED_HEADER]: 'true' }).headers,
  });
}

/**
 * Failure envelope from an explicit (code, message, status). Use for
 * domain errors whose codes live outside `ApiErrorCode` (e.g. the
 * send pipeline's `meta_error` / `whatsapp_not_configured`) — the
 * wire `code` is a free string, so any machine-meaningful value is
 * fine. `headers` is rarely needed; omit unless you have a
 * `Retry-After`-style set.
 */
export function fail(
  code: string,
  message: string,
  status: number,
  headers?: Record<string, string>
): NextResponse {
  const { requestId, headers: base } = v1Headers(headers);
  return NextResponse.json(
    { error: { code, message, request_id: requestId } },
    { status, headers: base }
  );
}

/**
 * Map any thrown value to the failure envelope. `ApiError` keeps its
 * code/status/headers; anything else collapses to a generic 500 so we
 * never leak internal error text onto the public wire.
 */
export function toApiErrorResponse(err: unknown): NextResponse {
  // Billing (fase 3 §4/§5). The envelope stays `{ error: { code,
  // message } }`; the extra fields ride alongside so an integrator can
  // branch on `code` and read the metric/limit without parsing prose.
  const billing = billingErrorPayload(err);
  if (billing) {
    const { status, error: message, code, ...rest } = billing;
    const { requestId, headers } = v1Headers();
    return NextResponse.json(
      { error: { code, message, ...rest, request_id: requestId } },
      { status, headers }
    );
  }
  if (err instanceof ApiError) {
    const { requestId, headers } = v1Headers(err.headers);
    return NextResponse.json(
      {
        error: { code: err.code, message: err.message, request_id: requestId },
      },
      { status: err.status, headers }
    );
  }
  // The id is logged next to the error so the opaque `request_id` the
  // caller sees actually leads somewhere.
  const { requestId, headers } = v1Headers();
  console.error(`[api/v1] uncategorized error (${requestId}):`, err);
  return NextResponse.json(
    {
      error: {
        code: 'internal',
        message: 'Internal server error',
        request_id: requestId,
      },
    },
    { status: 500, headers }
  );
}
