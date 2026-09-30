import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/accounts/[id]/plan — «Asignar plan a mano» (s9.4).
// The guard, the reason (same minimum as the 058 log), the 409 for a
// subscription PayPal is still billing, and the answer. What the write
// looks like and that the audit comes first is pinned in
// `src/lib/platform/provisioning.test.ts` (overridePlan).

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  summary: null as { id: string; name: string; createdAt: string } | null,
  calls: [] as Record<string, unknown>[],
  outcome: { ok: true, fromPlan: 'pro', fromProvider: 'paypal' } as
    | { ok: true; fromPlan: string | null; fromProvider: string | null }
    | { ok: false; reason: 'unknown_plan' | 'paypal_active' | 'audit_failed' },
  error: null as unknown,
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

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, reset: 0 }),
}));

vi.mock('@/lib/platform/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/accounts')>()),
  loadAccountSummary: async () => h.summary,
}));

vi.mock('@/lib/platform/provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/provisioning')>()),
  overridePlan: async (params: Record<string, unknown>) => {
    if (h.error) throw h.error;
    h.calls.push(params);
    return h.outcome;
  },
}));

const { POST } = await import('./route');
const { MIN_REASON_LENGTH } = await import('@/lib/platform/audit');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const TARGET = 'aaaaaaaa-0000-4000-8000-000000000001';
const REASON = 'comped: partner agreement 2026';

function call(body: unknown, id = TARGET) {
  return POST(
    new Request(`http://localhost/api/platform/accounts/${id}/plan`, {
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
  h.summary = { id: TARGET, name: 'Company A', createdAt: '2026-01-01' };
  h.calls = [];
  h.outcome = { ok: true, fromPlan: 'pro', fromProvider: 'paypal' };
  h.error = null;
});

describe('the guard', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await call({ planId: 'negocio', reason: REASON })).status).toBe(
      401
    );
    expect(h.calls).toEqual([]);
  });

  it('403s a company owner — including on his own company', async () => {
    h.user = { id: PLAIN_OWNER };
    expect((await call({ planId: 'negocio', reason: REASON })).status).toBe(
      403
    );
    expect(h.calls).toEqual([]);
  });
});

describe('the request', () => {
  it('400s a missing plan', async () => {
    expect((await call({ reason: REASON })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('400s a missing reason', async () => {
    expect((await call({ planId: 'negocio' })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('400s a reason shorter than the log minimum (the 058 constant)', async () => {
    expect(MIN_REASON_LENGTH).toBe(10);
    const res = await call({ planId: 'negocio', reason: 'x'.repeat(9) });
    expect(res.status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('404s a malformed id and an account that does not exist', async () => {
    expect(
      (await call({ planId: 'negocio', reason: REASON }, 'nope')).status
    ).toBe(404);
    h.summary = null;
    expect((await call({ planId: 'negocio', reason: REASON })).status).toBe(
      404
    );
    expect(h.calls).toEqual([]);
  });

  it('400s a plan that is not in the catalogue', async () => {
    h.outcome = { ok: false, reason: 'unknown_plan' };
    expect((await call({ planId: 'platinum', reason: REASON })).status).toBe(
      400
    );
  });
});

describe('assigning', () => {
  it('assigns the plan to THAT company, with the operator and the trimmed reason', async () => {
    const res = await call({ planId: ' negocio ', reason: `  ${REASON}  ` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accountId: TARGET,
      planId: 'negocio',
      provider: 'manual',
      status: 'active',
      fromPlan: 'pro',
      fromProvider: 'paypal',
    });
    expect(h.calls).toEqual([
      {
        accountId: TARGET,
        accountName: 'Company A',
        planId: 'negocio',
        actorUserId: OPERATOR,
        reason: REASON,
      },
    ]);
  });

  it('409s a subscription PayPal is still billing: cancel it there first', async () => {
    h.outcome = { ok: false, reason: 'paypal_active' };
    const res = await call({ planId: 'negocio', reason: REASON });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('paypal_active');
  });

  it('500s when the trail cannot be written (nothing was changed)', async () => {
    h.outcome = { ok: false, reason: 'audit_failed' };
    expect((await call({ planId: 'negocio', reason: REASON })).status).toBe(
      500
    );
  });

  it('500s without leaking the database error', async () => {
    h.error = new Error('relation "subscriptions" is on fire');
    const res = await call({ planId: 'negocio', reason: REASON });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('fire');
  });
});
