import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/accounts/[id]/hold — suspend and reactivate by
// hand (spec §2). Three things are on trial:
//
//   1. The guard. A company `owner` cannot suspend anybody, including
//      themselves.
//   2. The audit comes FIRST. A suspension nobody can trace is the same
//      back door the spec refuses for impersonation.
//   3. What gets written: the hold columns and nothing else. `status`
//      belongs to the PayPal webhook, and a hold stored there would be
//      lifted by the next payment event.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  summary: null as { id: string; name: string; createdAt: string } | null,
  audit: [] as Record<string, unknown>[],
  auditOk: true,
  holdCalls: [] as Record<string, unknown>[],
  holdApplied: true,
  holdError: null as unknown,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: (_c: string, userId: string) => ({
          maybeSingle: async () => ({
            data: h.admins.has(userId)
              ? { user_id: userId, granted_at: null, note: null }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/platform/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/accounts')>()),
  loadAccountSummary: async () => h.summary,
  setManualHold: async (params: Record<string, unknown>) => {
    if (h.holdError) throw h.holdError;
    h.holdCalls.push(params);
    return h.holdApplied;
  },
}));

vi.mock('@/lib/platform/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/audit')>()),
  recordPlatformAction: async (params: Record<string, unknown>) => {
    if (!h.auditOk) return false;
    h.audit.push(params);
    return true;
  },
}));

const { POST } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const TARGET = 'aaaaaaaa-0000-4000-8000-000000000001';
const REASON = 'chargebacks on three invoices, ticket 88';

function call(body: unknown, id = TARGET) {
  return POST(
    new Request(`http://localhost/api/platform/accounts/${id}/hold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.summary = {
    id: TARGET,
    name: 'Company A',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  h.audit = [];
  h.auditOk = true;
  h.holdCalls = [];
  h.holdApplied = true;
  h.holdError = null;
});

describe('the guard', () => {
  it('401s a visitor with no session, and holds nobody', async () => {
    h.user = null;
    expect((await call({ action: 'suspend', reason: REASON })).status).toBe(
      401
    );
    expect(h.holdCalls).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('403s a company owner — they cannot suspend anyone, themselves included', async () => {
    h.user = { id: PLAIN_OWNER };
    const res = await call({ action: 'suspend', reason: REASON });
    expect(res.status).toBe(403);
    expect(h.holdCalls).toEqual([]);
    expect(h.audit).toEqual([]);
  });
});

describe('the request', () => {
  it('400s an action that is neither suspend nor reactivate', async () => {
    for (const action of [undefined, 'delete', 42, null]) {
      const res = await call({ action, reason: REASON });
      expect(res.status).toBe(400);
    }
    expect(h.holdCalls).toEqual([]);
  });

  it('400s a missing reason — the trail is the point', async () => {
    const res = await call({ action: 'suspend' });
    expect(res.status).toBe(400);
    expect(h.audit).toEqual([]);
    expect(h.holdCalls).toEqual([]);
  });

  it('400s a reason too short to mean anything', async () => {
    const res = await call({ action: 'suspend', reason: '   spam   ' });
    expect(res.status).toBe(400);
    expect(h.holdCalls).toEqual([]);
  });

  it('404s an account that does not exist, and writes nothing', async () => {
    h.summary = null;
    const res = await call({ action: 'suspend', reason: REASON });
    expect(res.status).toBe(404);
    expect(h.audit).toEqual([]);
    expect(h.holdCalls).toEqual([]);
  });

  it('404s a malformed id', async () => {
    const res = await call({ action: 'suspend', reason: REASON }, 'nope');
    expect(res.status).toBe(404);
    expect(h.holdCalls).toEqual([]);
  });
});

describe('suspending', () => {
  it('records actor, account, moment and reason, and only then holds', async () => {
    const res = await call({ action: 'suspend', reason: REASON });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: TARGET, manualHold: true });

    expect(h.audit).toEqual([
      {
        action: 'suspend',
        actorUserId: OPERATOR,
        accountId: TARGET,
        accountName: 'Company A',
        reason: REASON,
      },
    ]);
    expect(h.holdCalls).toEqual([
      {
        accountId: TARGET,
        hold: true,
        actorUserId: OPERATOR,
        reason: REASON,
      },
    ]);
  });

  it('holds NOBODY when the trail cannot be written', async () => {
    h.auditOk = false;
    const res = await call({ action: 'suspend', reason: REASON });
    expect(res.status).toBe(500);
    // The whole rule in one assertion: an unrecorded suspension does not
    // happen at all.
    expect(h.holdCalls).toEqual([]);
  });

  it('409s an account with no subscription row to hold', async () => {
    h.holdApplied = false;
    const res = await call({ action: 'suspend', reason: REASON });
    expect(res.status).toBe(409);
  });

  it('trims the reason before it is stored', async () => {
    await call({ action: 'suspend', reason: `   ${REASON}   ` });
    expect(h.audit[0].reason).toBe(REASON);
    expect(h.holdCalls[0].reason).toBe(REASON);
  });
});

describe('reactivating', () => {
  it('lifts the hold, with its own line in the trail', async () => {
    const res = await call({
      action: 'reactivate',
      reason: 'refunded, ticket 88 closed',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: TARGET, manualHold: false });
    expect(h.audit[0]).toMatchObject({ action: 'reactivate' });
    expect(h.holdCalls[0]).toMatchObject({ hold: false });
  });

  it('needs a reason too — lifting a suspension is an act, not an undo', async () => {
    const res = await call({ action: 'reactivate', reason: 'ok' });
    expect(res.status).toBe(400);
    expect(h.holdCalls).toEqual([]);
  });
});

describe('failures', () => {
  it('500s without echoing the database error', async () => {
    h.holdError = new Error('column "manual_hold_at" does not exist');
    const res = await call({ action: 'suspend', reason: REASON });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('manual_hold_at');
  });
});
