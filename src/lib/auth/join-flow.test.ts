import { describe, expect, it, vi } from 'vitest';

import { CONFLICT_FALLBACK, parsePeek, resolveJoin } from './join-flow';

// i12.1 — /join/<token> without an "Accept" button (R12, R14, R15, R17,
// R19, R23, R32).

const PEEK_OK = {
  ok: true,
  account_name: 'Acme',
  role: 'agent',
  expires_at: '2026-11-10T00:00:00.000Z',
};

type Route = { status: number; body?: unknown } | 'network';

/** A fetch that answers peek and redeem from a table, and records calls. */
function fakeFetch(routes: { peek?: Route; redeem?: Route }) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const which = url.endsWith('/redeem') ? routes.redeem : routes.peek;
    if (!which) throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    if (which === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(which.body ?? {}), {
      status: which.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return fn as unknown as typeof fetch & typeof fn;
}

const signedIn = async () => true;
const signedOut = async () => false;

function posts(f: ReturnType<typeof fakeFetch>) {
  return f.mock.calls.filter(([, init]) => init?.method === 'POST');
}

describe('resolveJoin — signed in', () => {
  it('redeems with exactly ONE POST and goes to /dashboard on 200 (R12)', async () => {
    const f = fakeFetch({ redeem: { status: 200, body: { ok: true } } });
    const state = await resolveJoin({
      token: 'tok/1',
      isSignedIn: signedIn,
      fetchImpl: f,
    });
    expect(state).toEqual({ kind: 'redirect', to: '/dashboard' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(posts(f)).toHaveLength(1);
    expect(f.mock.calls[0][0]).toBe('/api/invitations/tok%2F1/redeem');
  });

  it('the already-member no-op (200) also lands on /dashboard (R19, R23)', async () => {
    const f = fakeFetch({
      redeem: { status: 200, body: { ok: true, accountId: 'A' } },
    });
    expect(
      await resolveJoin({ token: 't', isSignedIn: signedIn, fetchImpl: f })
    ).toEqual({ kind: 'redirect', to: '/dashboard' });
  });

  it('409 → conflict with the message and the company from peek (R14)', async () => {
    const f = fakeFetch({
      redeem: {
        status: 409,
        body: {
          error: 'Your account already contains data',
          reason: 'has_data',
        },
      },
      peek: { status: 200, body: PEEK_OK },
    });
    const state = await resolveJoin({
      token: 't',
      isSignedIn: signedIn,
      fetchImpl: f,
    });
    expect(state).toEqual({
      kind: 'conflict',
      message: 'Your account already contains data',
      peek: {
        account_name: 'Acme',
        role: 'agent',
        expires_at: PEEK_OK.expires_at,
      },
    });
    expect(posts(f)).toHaveLength(1);
  });

  it('409 with a failing peek → conflict without a name, fallback message', async () => {
    const f = fakeFetch({ redeem: { status: 409, body: {} }, peek: 'network' });
    expect(
      await resolveJoin({ token: 't', isSignedIn: signedIn, fetchImpl: f })
    ).toEqual({ kind: 'conflict', message: CONFLICT_FALLBACK, peek: null });
  });

  it.each(['not_found', 'used', 'expired', 'no_seats'])(
    '400 with reason %s → that failure (R15, R31)',
    async (reason) => {
      const f = fakeFetch({ redeem: { status: 400, body: { reason } } });
      expect(
        await resolveJoin({ token: 't', isSignedIn: signedIn, fetchImpl: f })
      ).toEqual({ kind: 'fail', reason });
    }
  );

  it('400 with an unknown reason → not_found', async () => {
    const f = fakeFetch({
      redeem: { status: 400, body: { reason: 'whatever' } },
    });
    expect(
      await resolveJoin({ token: 't', isSignedIn: signedIn, fetchImpl: f })
    ).toEqual({ kind: 'fail', reason: 'not_found' });
  });

  it('401 → the signed-out path (peek, no second POST)', async () => {
    const f = fakeFetch({
      redeem: { status: 401, body: { error: 'Unauthorized' } },
      peek: { status: 200, body: PEEK_OK },
    });
    const state = await resolveJoin({
      token: 't',
      isSignedIn: signedIn,
      fetchImpl: f,
    });
    expect(state.kind).toBe('signedOut');
    expect(posts(f)).toHaveLength(1);
  });

  it('500 → server_error', async () => {
    const f = fakeFetch({ redeem: { status: 500, body: { error: 'x' } } });
    expect(
      await resolveJoin({ token: 't', isSignedIn: signedIn, fetchImpl: f })
    ).toEqual({ kind: 'fail', reason: 'server_error' });
  });

  it('a network error → server_error', async () => {
    const f = fakeFetch({ redeem: 'network' });
    expect(
      await resolveJoin({ token: 't', isSignedIn: signedIn, fetchImpl: f })
    ).toEqual({ kind: 'fail', reason: 'server_error' });
  });
});

describe('resolveJoin — signed out (R17)', () => {
  it('one GET of peek and no POST at all', async () => {
    const f = fakeFetch({ peek: { status: 200, body: PEEK_OK } });
    const state = await resolveJoin({
      token: 't',
      isSignedIn: signedOut,
      fetchImpl: f,
    });
    expect(state).toEqual({
      kind: 'signedOut',
      peek: {
        account_name: 'Acme',
        role: 'agent',
        expires_at: PEEK_OK.expires_at,
      },
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(posts(f)).toHaveLength(0);
  });

  it.each(['not_found', 'used', 'expired', 'no_seats'])(
    'peek %s → that failure (R32)',
    async (reason) => {
      const f = fakeFetch({
        peek: { status: 200, body: { ok: false, reason } },
      });
      expect(
        await resolveJoin({ token: 't', isSignedIn: signedOut, fetchImpl: f })
      ).toEqual({ kind: 'fail', reason });
    }
  );

  it('peek 500 or unreachable → server_error', async () => {
    const f500 = fakeFetch({
      peek: { status: 500, body: { ok: false, reason: 'server_error' } },
    });
    expect(
      await resolveJoin({ token: 't', isSignedIn: signedOut, fetchImpl: f500 })
    ).toEqual({ kind: 'fail', reason: 'server_error' });
    const down = fakeFetch({ peek: 'network' });
    expect(
      await resolveJoin({ token: 't', isSignedIn: signedOut, fetchImpl: down })
    ).toEqual({ kind: 'fail', reason: 'server_error' });
  });

  it('an auth probe that throws counts as signed out', async () => {
    const f = fakeFetch({ peek: { status: 200, body: PEEK_OK } });
    const state = await resolveJoin({
      token: 't',
      isSignedIn: async () => {
        throw new Error('offline');
      },
      fetchImpl: f,
    });
    expect(state.kind).toBe('signedOut');
    expect(posts(f)).toHaveLength(0);
  });
});

describe('parsePeek', () => {
  it('rejects a body with an unknown role as server_error', () => {
    expect(parsePeek({ ...PEEK_OK, role: 'owner' })).toEqual({
      ok: false,
      reason: 'server_error',
    });
  });
});
