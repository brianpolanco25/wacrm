import { beforeEach, describe, expect, it, vi } from 'vitest';

// s9.6: which onboarding step an account is on, decided on the server
// from its subscription and its company profile, and the one-time stamp
// of `onboarding_completed_at`.

const h = vi.hoisted(() => ({
  accounts: {} as Record<string, Record<string, unknown>>,
  selectError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  queries: [] as {
    table: string;
    op: 'select' | 'update';
    values?: Record<string, unknown>;
    filters: [string, string, unknown][];
  }[],
  getEntitlements: vi.fn(),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const q = {
        table,
        op: 'select' as 'select' | 'update',
        values: undefined as Record<string, unknown> | undefined,
        filters: [] as [string, string, unknown][],
      };
      h.queries.push(q);
      const run = () => {
        if (q.op === 'update') {
          if (h.updateError) return { data: null, error: h.updateError };
          const id = q.filters.find(([, c]) => c === 'id')?.[2] as string;
          const row = h.accounts[id];
          const stillNull = q.filters.some(
            ([op, c, v]) =>
              op === 'is' && c === 'onboarding_completed_at' && v === null
          );
          if (row && (!stillNull || row.onboarding_completed_at == null)) {
            Object.assign(row, q.values);
          }
          return { data: null, error: null };
        }
        if (h.selectError) return { data: null, error: h.selectError };
        const id = q.filters.find(([, c]) => c === 'id')?.[2] as string;
        return {
          data: h.accounts[id] ? { ...h.accounts[id] } : null,
          error: null,
        };
      };
      const chain = {
        select: () => chain,
        update: (values: Record<string, unknown>) => {
          q.op = 'update';
          q.values = values;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          q.filters.push(['eq', c, v]);
          return chain;
        },
        is: (c: string, v: unknown) => {
          q.filters.push(['is', c, v]);
          return chain;
        },
        maybeSingle: async () => run(),
        then: (resolve: (v: unknown) => unknown) => resolve(run()),
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/billing/enforce', () => ({
  getEntitlements: h.getEntitlements,
}));

import { loadOnboardingState } from './state';

const A = 'acct-a';
const B = 'acct-b';

const PROFILE = {
  country: 'DO',
  phone: '+1 809 555 0101',
  industry: 'retail',
  team_size: '2-5',
};

function account(id: string, overrides: Record<string, unknown> = {}) {
  h.accounts[id] = {
    id,
    name: `Company ${id}`,
    country: null,
    phone: null,
    industry: null,
    team_size: null,
    onboarding_completed_at: null,
    ...overrides,
  };
}

function subscription(status: string, extra: Record<string, unknown> = {}) {
  h.getEntitlements.mockResolvedValue({
    planId: status === 'incomplete' ? 'inicio' : 'pro',
    status,
    limits: {},
    features: [],
    readOnly: status === 'incomplete',
    readOnlyReason: status === 'incomplete' ? 'subscription' : null,
    manualHold: false,
    trialEndsAt: null,
    ...extra,
  });
}

beforeEach(() => {
  h.accounts = {};
  h.queries = [];
  h.selectError = null;
  h.updateError = null;
  h.getEntitlements.mockReset();
  account(A);
  account(B, { ...PROFILE });
});

describe('loadOnboardingState — the step', () => {
  it('a new signup (incomplete, no profile) starts at the company step', async () => {
    subscription('incomplete');
    const s = await loadOnboardingState({ accountId: A, role: 'owner' });
    expect(s).toMatchObject({
      step: 'company',
      status: 'incomplete',
      canEditCompany: true,
      canPay: true,
      profileComplete: false,
      completedAt: null,
    });
  });

  it('an incomplete account with its profile goes to the plan step, and is not stamped', async () => {
    account(A, PROFILE);
    subscription('incomplete');
    const s = await loadOnboardingState({ accountId: A, role: 'owner' });
    expect(s.step).toBe('plan');
    expect(s.completedAt).toBeNull();
    expect(h.queries.filter((q) => q.op === 'update')).toHaveLength(0);
  });

  it.each(['admin', 'agent', 'viewer'] as const)(
    'gates every member of an incomplete account, %s included',
    async (role) => {
      subscription('incomplete');
      const s = await loadOnboardingState({ accountId: A, role });
      expect(s.step).toBe('company');
      expect(s.canEditCompany).toBe(false);
      expect(s.canPay).toBe(role === 'admin');
    }
  );

  it('a paying account with its profile is done — and stamps the onboarding once', async () => {
    account(A, PROFILE);
    subscription('active');
    const s = await loadOnboardingState({ accountId: A, role: 'owner' });
    expect(s.step).toBe('done');
    expect(s.completedAt).toEqual(expect.any(String));
    expect(h.accounts[A].onboarding_completed_at).toBe(s.completedAt);

    const again = await loadOnboardingState({ accountId: A, role: 'owner' });
    expect(again.completedAt).toBe(s.completedAt);
    expect(h.queries.filter((q) => q.op === 'update')).toHaveLength(1);
  });

  it('a manual plan (s9.4) without company data only shows step 1 to the owner', async () => {
    subscription('active', { planId: 'negocio' });
    const owner = await loadOnboardingState({ accountId: A, role: 'owner' });
    expect(owner.step).toBe('company');
    // …and does not hold the team hostage: they cannot fill it in.
    const agent = await loadOnboardingState({ accountId: A, role: 'agent' });
    expect(agent.step).toBe('done');
    expect(h.accounts[A].onboarding_completed_at).toBeNull();
  });

  it.each(['past_due', 'suspended', 'cancelled', 'expired', 'trialing'])(
    'a %s account is not gated by onboarding (the dunning ladder owns it)',
    async (status) => {
      account(A, PROFILE);
      subscription(status);
      const s = await loadOnboardingState({ accountId: A, role: 'owner' });
      expect(s.step).toBe('done');
    }
  );

  it('the stamp never overrides incomplete: a stamped but unpaid account is gated', async () => {
    account(A, { ...PROFILE, onboarding_completed_at: '2026-09-01T00:00:00Z' });
    subscription('incomplete');
    const s = await loadOnboardingState({ accountId: A, role: 'owner' });
    expect(s.step).toBe('plan');
  });

  it('a failed stamp is not a failure: still done, logged', async () => {
    account(A, PROFILE);
    subscription('active');
    h.updateError = { message: 'boom' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await loadOnboardingState({ accountId: A, role: 'owner' });
    expect(s.step).toBe('done');
    expect(s.completedAt).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('throws on a read error instead of guessing a step', async () => {
    subscription('incomplete');
    h.selectError = { message: 'down' };
    await expect(
      loadOnboardingState({ accountId: A, role: 'owner' })
    ).rejects.toMatchObject({
      message: 'down',
    });
  });
});

describe('loadOnboardingState — accounts locked after paying (review s9.6, finding 1)', () => {
  // Pre-073 accounts have NULL company columns. If the account is read-only
  // for billing or a hold, sending its owner to step 1 is a trap: the
  // company route refuses the save and /billing sits behind the gate.
  it.each([
    ['suspended', {}],
    ['expired', {}],
    ['past_due past its grace', { status: 'past_due' }],
    [
      'active with a manual hold',
      { status: 'active', manualHold: true, readOnlyReason: 'manual_hold' },
    ],
  ] as const)(
    '%s, no company profile, owner → done (the dunning ladder and /billing own it)',
    async (label, extra) => {
      const status = (extra as { status?: string }).status ?? label;
      subscription(status, {
        readOnly: true,
        readOnlyReason: 'subscription',
        ...extra,
      });
      const s = await loadOnboardingState({ accountId: A, role: 'owner' });
      expect(s.step).toBe('done');
      expect(s.profileComplete).toBe(false);
      // Nothing is stamped: the profile is still owed.
      expect(h.queries.filter((q) => q.op === 'update')).toHaveLength(0);
      expect(h.accounts[A].onboarding_completed_at).toBeNull();
    }
  );

  it('an incomplete account an operator put on hold is not sent to onboarding either', async () => {
    subscription('incomplete', {
      manualHold: true,
      readOnlyReason: 'manual_hold',
    });
    const s = await loadOnboardingState({ accountId: A, role: 'owner' });
    expect(s.step).toBe('done');
  });

  it('a past_due account still inside its grace (writable) is asked for the profile', async () => {
    subscription('past_due', { readOnly: false, readOnlyReason: null });
    const s = await loadOnboardingState({ accountId: A, role: 'owner' });
    expect(s.step).toBe('company');
  });
});

describe('loadOnboardingState — isolation (service role, CP3)', () => {
  it('reads and stamps ONLY the caller account, and leaves B untouched', async () => {
    account(A, PROFILE);
    subscription('active');
    const before = { ...h.accounts[B] };

    await loadOnboardingState({ accountId: A, role: 'owner' });

    expect(h.queries.length).toBeGreaterThan(0);
    for (const q of h.queries) {
      expect(q.table).toBe('accounts');
      expect(q.filters).toContainEqual(['eq', 'id', A]);
      expect(q.filters.some(([, , v]) => v === B)).toBe(false);
    }
    const stamp = h.queries.find((q) => q.op === 'update');
    expect(stamp?.values).toEqual({
      onboarding_completed_at: expect.any(String),
    });
    expect(stamp?.filters).toContainEqual([
      'is',
      'onboarding_completed_at',
      null,
    ]);
    expect(h.getEntitlements).toHaveBeenCalledWith(A);
    expect(h.accounts[B]).toEqual(before);
  });
});
