import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApiKeyContext } from '@/lib/auth/api-context';
import { FakeIdempotencyStore } from './fake-idempotency-store';
import {
  IDEMPOTENCY_TTL_MS,
  __resetIdempotencyPurgeCounter,
  withIdempotency,
} from './idempotency';
import {
  IDEMPOTENT_REPLAYED_HEADER,
  ok,
  fail,
  toApiErrorResponse,
} from './respond';

// ---------------------------------------------------------------------------
// Fase 7 §1 — `withIdempotency`, the piece a7.2/a7.3/a7.5 will reuse.
//
// The store is `FakeIdempotencyStore`, which enforces the real UNIQUE
// (api_key_id, idempotency_key) index and answers 23505 when it is violated
// — so "two concurrent retries do the work once" is exercised against the
// same arbitration Postgres provides, not against a stub that always says
// yes.
// ---------------------------------------------------------------------------

const ACCOUNT_A = 'acct-a';
const KEY_1 = 'key-1';
const KEY_2 = 'key-2';

let store: FakeIdempotencyStore;

function ctxFor(keyId: string, accountId = ACCOUNT_A): ApiKeyContext {
  return {
    authType: 'api_key',
    supabase: store as unknown as SupabaseClient,
    accountId,
    keyId,
    scopes: ['messages:send'],
    createdBy: null,
  };
}

function req(
  body: unknown,
  idempotencyKey?: string,
  path = '/api/v1/messages'
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
  return new Request(`https://crm.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** Runs the wrapper the way a route does, mapping throws to the envelope. */
async function run(
  ctx: ApiKeyContext,
  request: Request,
  handler: (body: Record<string, unknown>) => Promise<Response>
) {
  try {
    return await withIdempotency(
      ctx,
      request,
      handler as (body: Record<string, unknown>) => Promise<never>
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

beforeEach(() => {
  store = new FakeIdempotencyStore();
  __resetIdempotencyPurgeCounter();
});

describe('withIdempotency', () => {
  it('without the header nothing is stored and the handler always runs', async () => {
    const handler = vi.fn(async () => ok({ n: 1 }, 201));
    await run(ctxFor(KEY_1), req({ a: 1 }), handler);
    await run(ctxFor(KEY_1), req({ a: 1 }), handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(0);
  });

  it('same key and same body: the handler runs once, the retry is replayed', async () => {
    const handler = vi.fn(async () => ok({ message_id: 'm-1' }, 201));

    const first = await run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), handler);
    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    await expect(first.json()).resolves.toEqual({
      data: { message_id: 'm-1' },
    });

    const second = await run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    // Byte-for-byte the first response.
    await expect(second.json()).resolves.toEqual({
      data: { message_id: 'm-1' },
    });
  });

  it('same key, different body: 409 idempotency_mismatch and no second run', async () => {
    const handler = vi.fn(async () => ok({ message_id: 'm-1' }, 201));
    await run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), handler);

    const res = await run(ctxFor(KEY_1), req({ a: 2 }, 'idem-1'), handler);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_mismatch');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('same key on a different endpoint is a mismatch, not a wrong replay', async () => {
    const handler = vi.fn(async () => ok({ message_id: 'm-1' }, 201));
    await run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), handler);

    const res = await run(
      ctxFor(KEY_1),
      req({ a: 1 }, 'idem-1', '/api/v1/broadcasts'),
      handler
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_mismatch');
  });

  it('another API KEY with the same Idempotency-Key never sees the stored response', async () => {
    const first = vi.fn(async () => ok({ message_id: 'from-key-1' }, 201));
    await run(ctxFor(KEY_1), req({ a: 1 }, 'shared'), first);

    const second = vi.fn(async () => ok({ message_id: 'from-key-2' }, 201));
    const res = await run(ctxFor(KEY_2), req({ a: 1 }, 'shared'), second);

    expect(second).toHaveBeenCalledTimes(1);
    expect(res.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    await expect(res.json()).resolves.toEqual({
      data: { message_id: 'from-key-2' },
    });
    // Two independent rows; neither key can reach the other's.
    expect(store.rows).toHaveLength(2);
  });

  it('every query it makes is scoped by account_id', async () => {
    const handler = vi.fn(async () => ok({ n: 1 }, 201));
    await run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), handler);
    await run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), handler);

    const reads = store.seen.filter((q) => q.action !== 'insert');
    expect(reads.length).toBeGreaterThan(0);
    for (const query of reads) {
      expect(
        query.filters.some(
          (f) => f.column === 'account_id' && f.value === ACCOUNT_A
        )
      ).toBe(true);
    }
    // The reservation carries the account on the row itself.
    expect(store.rows.every((r) => r.account_id === ACCOUNT_A)).toBe(true);
  });

  it('a concurrent retry gets 409 conflict instead of doing the work twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      await gate;
      return ok({ message_id: 'm-1' }, 201);
    });

    const inflight = run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), handler);
    // Wait for the reservation to land rather than trusting microtask
    // ordering — the race we want to reproduce is "row exists, response
    // does not", and it has to be that one every run.
    while (store.rows.length === 0) await new Promise((r) => setTimeout(r, 0));
    expect(store.rows[0].response_status).toBeNull();

    // Second call lands while the first is still inside the handler.
    const racer = await run(
      ctxFor(KEY_1),
      req({ a: 1 }, 'idem-1'),
      vi.fn(async () => ok({ message_id: 'DOUBLE-SEND' }, 201))
    );
    expect(racer.status).toBe(409);
    const body = (await racer.json()) as { error: { code: string } };
    expect(body.error.code).toBe('conflict');

    release();
    await expect((await inflight).json()).resolves.toEqual({
      data: { message_id: 'm-1' },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx response releases the key so a corrected retry can reuse it', async () => {
    const rejecting = vi.fn(async () => fail('bad_request', 'nope', 400));
    const first = await run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), rejecting);
    expect(first.status).toBe(400);
    expect(store.rows).toHaveLength(0);

    const accepting = vi.fn(async () => ok({ message_id: 'm-1' }, 201));
    const second = await run(ctxFor(KEY_1), req({ a: 9 }, 'idem-1'), accepting);
    expect(second.status).toBe(201);
    expect(accepting).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler releases the key and lets the error through untouched', async () => {
    const boom = new Error('meta exploded');
    await expect(
      withIdempotency(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(store.rows).toHaveLength(0);
  });

  it('after the 24 h window the key is free again', async () => {
    const handler = vi.fn(async () => ok({ message_id: 'm-1' }, 201));
    await run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), handler);
    expect(store.rows).toHaveLength(1);
    // The row it wrote really is 24 h out, not some other TTL.
    const written = store.rows[0];
    const ttl = new Date(written.expires_at as string).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(IDEMPOTENCY_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(IDEMPOTENCY_TTL_MS);

    // Age it past the window: a different body under the same key is now
    // a fresh request, not a mismatch.
    written.expires_at = new Date(Date.now() - 1_000).toISOString();
    const res = await run(ctxFor(KEY_1), req({ a: 2 }, 'idem-1'), handler);
    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(1);
  });

  it('rejects an empty or over-long Idempotency-Key with 400', async () => {
    const handler = vi.fn(async () => ok({ n: 1 }, 201));
    const blank = await run(ctxFor(KEY_1), req({ a: 1 }, '   '), handler);
    expect(blank.status).toBe(400);
    const tooLong = await run(
      ctxFor(KEY_1),
      req({ a: 1 }, 'x'.repeat(256)),
      handler
    );
    expect(tooLong.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('still serves the request when the store itself is down', async () => {
    const handler = vi.fn(async () => ok({ message_id: 'm-1' }, 201));
    store.failNextWrite = { message: 'connection refused' };
    const res = await run(ctxFor(KEY_1), req({ a: 1 }, 'idem-1'), handler);
    // Bookkeeping is not the feature the caller asked for.
    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('inherits the body guards: text/plain is 415 before anything is reserved', async () => {
    const handler = vi.fn(async () => ok({ n: 1 }, 201));
    const request = new Request('https://crm.test/api/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'Idempotency-Key': 'idem-1' },
      body: '{"a":1}',
    });
    const res = await run(ctxFor(KEY_1), request, handler);
    expect(res.status).toBe(415);
    expect(handler).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });
});
