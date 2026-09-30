import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// s9.6 — POST /api/onboarding/company, step 1 of the paid onboarding.
//
// Runs the REAL `requireRole` (role check, support session, read-only
// option) over a mocked Supabase session client, so "owner only" is
// tested, not assumed. The billing layer and the onboarding state are
// mocked at their module boundary.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  user: { id: 'user-a' } as { id: string } | null,
  profile: { account_id: 'acct-a', account_role: 'owner' } as Record<
    string,
    unknown
  > | null,
  support: null as null | { accountId: string; expiresAt: number },
  updateError: null as { message: string } | null,
  updateReturnsNothing: false,
  updates: [] as {
    table: string;
    values: Record<string, unknown>;
    filters: [string, unknown][];
  }[],
  getEntitlements: vi.fn(),
  loadOnboardingState: vi.fn(),
  markSupportActionStatus: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user }, error: null }),
    },
    from: (table: string) => {
      let op: 'select' | 'update' = 'select';
      let values: Record<string, unknown> = {};
      const filters: [string, unknown][] = [];
      const chain = {
        select: () => chain,
        update: (v: Record<string, unknown>) => {
          op = 'update';
          values = v;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          filters.push([c, v]);
          return chain;
        },
        maybeSingle: async () => {
          if (op === 'update') {
            h.updates.push({ table, values, filters: [...filters] });
            if (h.updateError) return { data: null, error: h.updateError };
            if (h.updateReturnsNothing) return { data: null, error: null };
            return {
              data: { id: filters.find(([c]) => c === 'id')?.[1] },
              error: null,
            };
          }
          if (table === 'profiles') return { data: h.profile, error: null };
          if (table === 'accounts') {
            return {
              data: { id: h.profile?.account_id, name: 'Company A' },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/auth/impersonation', () => ({
  resolveSupportSession: async () => h.support,
}));
vi.mock('@/lib/auth/support-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/support-actions')>()),
  markSupportActionStatus: h.markSupportActionStatus,
}));
vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'acct-t', name: 'Company T' },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  getEntitlements: h.getEntitlements,
}));
vi.mock('@/lib/onboarding/state', () => ({
  loadOnboardingState: h.loadOnboardingState,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));

import { POST } from './route';

const BODY = {
  name: 'Ferretería Polanco',
  country: 'DO',
  phone: '+1 809 555 0101',
  industry: 'retail',
  teamSize: '2-5',
};

function entitlements(status: string, extra: Record<string, unknown> = {}) {
  const readOnly = ['incomplete', 'suspended', 'expired'].includes(status);
  return {
    planId: 'inicio',
    status,
    limits: {},
    features: [],
    readOnly,
    readOnlyReason: readOnly ? 'subscription' : null,
    manualHold: false,
    trialEndsAt: null,
    ...extra,
  };
}

function post(body: unknown = BODY) {
  return POST(
    new Request('https://crm.example.com/api/onboarding/company', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  h.user = { id: 'user-a' };
  h.profile = { account_id: 'acct-a', account_role: 'owner' };
  h.support = null;
  h.updateError = null;
  h.updateReturnsNothing = false;
  h.updates = [];
  h.getEntitlements.mockReset().mockResolvedValue(entitlements('incomplete'));
  h.loadOnboardingState.mockReset().mockResolvedValue({ step: 'plan' });
});

describe('POST /api/onboarding/company', () => {
  it('401s without a session, and writes nothing', async () => {
    h.user = null;
    const res = await post();
    expect(res.status).toBe(401);
    expect(h.updates).toHaveLength(0);
  });

  it.each(['admin', 'agent', 'viewer'])(
    '403s a %s: step 1 is owner-only',
    async (role) => {
      h.profile = { account_id: 'acct-a', account_role: role };
      const res = await post();
      expect(res.status).toBe(403);
      expect(h.updates).toHaveLength(0);
    }
  );

  it('403s a support session (an admin, and never the customer’s owner)', async () => {
    h.support = { accountId: 'acct-t', expiresAt: Date.now() + 60_000 };
    const res = await post();
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });

  it.each([
    ['name', { name: '' }],
    ['country', { country: 'XX' }],
    ['phone', { phone: 'abc' }],
    ['industry', { industry: 'mining' }],
    ['teamSize', { teamSize: '100' }],
  ])('400s a bad %s and names the field', async (field, patch) => {
    const res = await post({ ...BODY, ...patch });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.field).toBe(field);
    expect(h.updates).toHaveLength(0);
  });

  it('400s a body that is not JSON', async () => {
    const res = await POST(
      new Request('https://crm.example.com/api/onboarding/company', {
        method: 'POST',
        body: 'not json',
      })
    );
    expect(res.status).toBe(400);
  });

  it('saves the profile of an INCOMPLETE account (read-only, but this is its way in) and answers the next step', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ step: 'plan' });
    expect(h.updates).toEqual([
      {
        table: 'accounts',
        values: {
          name: 'Ferretería Polanco',
          country: 'DO',
          phone: '+1 809 555 0101',
          industry: 'retail',
          team_size: '2-5',
        },
        filters: [['id', 'acct-a']],
      },
    ]);
    expect(h.loadOnboardingState).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-a', role: 'owner' })
    );
  });

  it('answers done for an account that already pays (manual plan): step 1 was all it lacked', async () => {
    h.getEntitlements.mockResolvedValue(entitlements('active'));
    h.loadOnboardingState.mockResolvedValue({ step: 'done' });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ step: 'done' });
  });

  it('writes the CALLER account only — an accountId in the body is ignored (CP3)', async () => {
    const res = await post({ ...BODY, accountId: 'acct-b', id: 'acct-b' });
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].filters).toEqual([['id', 'acct-a']]);
    expect(Object.keys(h.updates[0].values)).not.toContain('id');
    expect(Object.keys(h.updates[0].values)).not.toContain(
      'onboarding_completed_at'
    );
    expect(h.getEntitlements).toHaveBeenCalledWith('acct-a');
  });

  it.each(['suspended', 'expired'])(
    '403s a %s account: its lock is settled at /billing, not here',
    async (status) => {
      h.getEntitlements.mockResolvedValue(entitlements(status));
      const res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).upgradeUrl).toBe('/billing');
      expect(h.updates).toHaveLength(0);
    }
  );

  it('403s an incomplete account an operator put on hold', async () => {
    h.getEntitlements.mockResolvedValue(
      entitlements('incomplete', {
        manualHold: true,
        readOnlyReason: 'manual_hold',
      })
    );
    const res = await post();
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });

  it('500s, without leaking the database error, when the update fails or matches nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.updateError = { message: 'permission denied for table accounts' };
    let res = await post();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/permission denied/);

    h.updateError = null;
    h.updateReturnsNothing = true;
    res = await post();
    expect(res.status).toBe(500);
    expect(h.loadOnboardingState).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
