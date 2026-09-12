import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared, hoisted state the admin-client mock closes over. Each test sets
// the rows it wants the fake DB to return; every query is recorded so we
// can assert the account_id filter is always present (leak test).
const h = vi.hoisted(() => ({
  state: {
    subscription: null as Record<string, unknown> | null,
    subscriptionError: null as { message: string } | null,
    plans: {} as Record<string, Record<string, unknown>>,
    usage: null as Record<string, unknown> | null,
    usageError: null as { message: string } | null,
    queries: [] as { table: string; filters: [string, unknown][] }[],
  },
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const q = { table, filters: [] as [string, unknown][] };
      h.state.queries.push(q);
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          q.filters.push([col, val]);
          return chain;
        },
        maybeSingle: () => {
          if (table === 'subscriptions') {
            return Promise.resolve({
              data: h.state.subscription,
              error: h.state.subscriptionError,
            });
          }
          if (table === 'plans') {
            const id = q.filters.find(([c]) => c === 'id')?.[1] as string;
            return Promise.resolve({
              data: h.state.plans[id] ?? null,
              error: null,
            });
          }
          if (table === 'usage_counters') {
            return Promise.resolve({
              data: h.state.usage,
              error: h.state.usageError,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  }),
}));

import {
  assertFeature,
  assertQuota,
  currentPeriodStart,
  FeatureNotAvailableError,
  getEntitlements,
  hasFeature,
  isReadOnly,
  normalizeLimits,
  QuotaExceededError,
  TRIAL_PLAN_ID,
  type Entitlements,
} from './entitlements';

const ACCOUNT = 'acct-1';

const PRO = {
  id: 'pro',
  limits: {
    operators: 10,
    messages_out: 15000,
    ai_replies: 3000,
    retention_months: 24,
  },
  features: ['ai_autoreply', 'ai_knowledge', 'auto_assign', 'api', 'webhooks'],
};

const NEGOCIO = {
  id: 'negocio',
  limits: { operators: 30, ai_replies: 15000, retention_months: null },
  features: [...PRO.features, 'multi_number', 'priority_support'],
};

const INICIO = {
  id: 'inicio',
  limits: { operators: 3, ai_replies: 500, retention_months: 12 },
  features: ['ai_autoreply', 'ai_knowledge', 'auto_assign'],
};

function subscribed(overrides: Record<string, unknown> = {}) {
  h.state.subscription = {
    plan_id: 'inicio',
    status: 'active',
    trial_ends_at: null,
    grace_until: null,
    ...overrides,
  };
}

beforeEach(() => {
  h.state.subscription = null;
  h.state.subscriptionError = null;
  h.state.plans = { pro: PRO, negocio: NEGOCIO, inicio: INICIO };
  h.state.usage = null;
  h.state.usageError = null;
  h.state.queries = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getEntitlements', () => {
  it('resolves an account with no subscription row to the trial plan (pro, trialing, not read-only)', async () => {
    const e = await getEntitlements(ACCOUNT);
    expect(TRIAL_PLAN_ID).toBe('pro');
    expect(e.planId).toBe('pro');
    expect(e.status).toBe('trialing');
    expect(e.readOnly).toBe(false);
    expect(e.trialEndsAt).toBeNull();
    expect(e.limits).toEqual(PRO.limits);
    expect(e.features).toEqual(PRO.features);
  });

  it('uses the subscribed plan, status and trial end when a row exists', async () => {
    subscribed({
      plan_id: 'negocio',
      status: 'trialing',
      trial_ends_at: '2026-09-24T00:00:00.000Z',
    });
    const e = await getEntitlements(ACCOUNT);
    expect(e.planId).toBe('negocio');
    expect(e.status).toBe('trialing');
    expect(e.trialEndsAt).toBe('2026-09-24T00:00:00.000Z');
    expect(e.limits.retention_months).toBeNull();
    expect(e.features).toContain('multi_number');
  });

  it('always filters subscriptions and usage by account_id (leak test)', async () => {
    subscribed({ plan_id: 'pro' });
    await getEntitlements(ACCOUNT);
    const subQuery = h.state.queries.find((q) => q.table === 'subscriptions');
    expect(subQuery?.filters).toContainEqual(['account_id', ACCOUNT]);

    h.state.queries = [];
    h.state.usage = { value: 0 };
    await assertQuota(ACCOUNT, 'ai_replies');
    const usageQuery = h.state.queries.find(
      (q) => q.table === 'usage_counters'
    );
    expect(usageQuery?.filters).toContainEqual(['account_id', ACCOUNT]);
    expect(usageQuery?.filters).toContainEqual(['metric', 'ai_replies']);
  });

  it('throws when the subscription query errors (never degrades to "no limits")', async () => {
    h.state.subscriptionError = { message: 'boom' };
    await expect(getEntitlements(ACCOUNT)).rejects.toMatchObject({
      message: 'boom',
    });
  });

  it('throws when the resolved plan is missing from the catalogue', async () => {
    h.state.plans = {};
    await expect(getEntitlements(ACCOUNT)).rejects.toThrow(
      /plan 'pro' is missing/
    );
  });

  it('falls back to trialing when the stored status is not a known value', async () => {
    subscribed({ status: 'weird' });
    const e = await getEntitlements(ACCOUNT);
    expect(e.status).toBe('trialing');
  });

  describe('readOnly', () => {
    it.each([
      ['trialing', false],
      ['active', false],
      ['cancelled', false],
      ['suspended', true],
      ['expired', true],
    ] as const)('status %s → readOnly %s', async (status, expected) => {
      subscribed({ status });
      const e = await getEntitlements(ACCOUNT);
      expect(e.readOnly).toBe(expected);
    });

    it('past_due is read-only only once grace_until has passed', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();

      subscribed({ status: 'past_due', grace_until: past });
      expect((await getEntitlements(ACCOUNT)).readOnly).toBe(true);

      subscribed({ status: 'past_due', grace_until: future });
      expect((await getEntitlements(ACCOUNT)).readOnly).toBe(false);

      subscribed({ status: 'past_due', grace_until: null });
      expect((await getEntitlements(ACCOUNT)).readOnly).toBe(false);
    });
  });
});

describe('isReadOnly (pure)', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  it('handles every status', () => {
    expect(isReadOnly('suspended', null, now)).toBe(true);
    expect(isReadOnly('expired', null, now)).toBe(true);
    expect(isReadOnly('past_due', '2026-09-01T00:00:00Z', now)).toBe(true);
    expect(isReadOnly('past_due', '2026-09-20T00:00:00Z', now)).toBe(false);
    expect(isReadOnly('past_due', null, now)).toBe(false);
    expect(isReadOnly('past_due', 'not-a-date', now)).toBe(false);
    expect(isReadOnly('active', '2026-09-01T00:00:00Z', now)).toBe(false);
    expect(isReadOnly('trialing', null, now)).toBe(false);
    expect(isReadOnly('cancelled', null, now)).toBe(false);
  });
});

describe('hasFeature / assertFeature', () => {
  const e: Entitlements = {
    planId: 'inicio',
    status: 'active',
    limits: {},
    features: ['ai_autoreply'],
    readOnly: false,
    readOnlyReason: null,
    manualHold: false,
    trialEndsAt: null,
  };
  it('is a plain membership check', () => {
    expect(hasFeature(e, 'ai_autoreply')).toBe(true);
    expect(hasFeature(e, 'api')).toBe(false);
  });
  it('assertFeature throws the typed error carrying the feature', () => {
    expect(() => assertFeature(e, 'ai_autoreply')).not.toThrow();
    let caught: unknown;
    try {
      assertFeature(e, 'api');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FeatureNotAvailableError);
    expect((caught as FeatureNotAvailableError).feature).toBe('api');
  });
});

describe('assertQuota', () => {
  it('throws QuotaExceededError with metric/limit/used when used + n exceeds the limit', async () => {
    subscribed({ plan_id: 'inicio' }); // ai_replies: 500
    h.state.usage = { value: 500 };
    let caught: unknown;
    try {
      await assertQuota(ACCOUNT, 'ai_replies');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuotaExceededError);
    const q = caught as QuotaExceededError;
    expect(q.metric).toBe('ai_replies');
    expect(q.limit).toBe(500);
    expect(q.used).toBe(500);
  });

  it('accounts for n: 498 used + 2 passes, + 3 throws', async () => {
    subscribed({ plan_id: 'inicio' });
    h.state.usage = { value: 498 };
    await expect(
      assertQuota(ACCOUNT, 'ai_replies', 2)
    ).resolves.toBeUndefined();
    await expect(assertQuota(ACCOUNT, 'ai_replies', 3)).rejects.toBeInstanceOf(
      QuotaExceededError
    );
  });

  it('does not throw when the limit is null (unlimited) and never reads the counter', async () => {
    subscribed({ plan_id: 'negocio' }); // retention_months: null
    h.state.usage = { value: 10_000_000 };
    await expect(
      assertQuota(ACCOUNT, 'retention_months')
    ).resolves.toBeUndefined();
    expect(h.state.queries.some((q) => q.table === 'usage_counters')).toBe(
      false
    );
  });

  it('does not throw for an unknown metric', async () => {
    subscribed({ plan_id: 'inicio' });
    h.state.usage = { value: 10_000_000 };
    await expect(assertQuota(ACCOUNT, 'unicorns')).resolves.toBeUndefined();
    expect(h.state.queries.some((q) => q.table === 'usage_counters')).toBe(
      false
    );
  });

  it('treats a missing counter row as zero usage', async () => {
    subscribed({ plan_id: 'inicio' });
    h.state.usage = null;
    await expect(
      assertQuota(ACCOUNT, 'ai_replies', 500)
    ).resolves.toBeUndefined();
    await expect(
      assertQuota(ACCOUNT, 'ai_replies', 501)
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('uses the trial plan limits for an account without a subscription', async () => {
    // No subscription → pro → ai_replies 3000.
    h.state.usage = { value: 3000 };
    await expect(assertQuota(ACCOUNT, 'ai_replies')).rejects.toBeInstanceOf(
      QuotaExceededError
    );
    h.state.usage = { value: 2999 };
    await expect(assertQuota(ACCOUNT, 'ai_replies')).resolves.toBeUndefined();
  });

  it('reads the counter for the current calendar month (UTC)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T23:30:00Z'));
    subscribed({ plan_id: 'inicio' });
    h.state.usage = { value: 0 };
    await assertQuota(ACCOUNT, 'ai_replies');
    const usageQuery = h.state.queries.find(
      (q) => q.table === 'usage_counters'
    );
    expect(usageQuery?.filters).toContainEqual(['period_start', '2026-09-01']);
  });

  it('surfaces a counter read error instead of assuming zero', async () => {
    subscribed({ plan_id: 'inicio' });
    h.state.usageError = { message: 'db down' };
    await expect(assertQuota(ACCOUNT, 'ai_replies')).rejects.toMatchObject({
      message: 'db down',
    });
  });
});

describe('pure helpers', () => {
  it('currentPeriodStart anchors to the first of the UTC month', () => {
    expect(currentPeriodStart(new Date('2026-01-31T23:59:59Z'))).toBe(
      '2026-01-01'
    );
    expect(currentPeriodStart(new Date('2026-12-01T00:00:00Z'))).toBe(
      '2026-12-01'
    );
  });

  it('normalizeLimits keeps finite numbers and nulls, drops everything else', () => {
    expect(
      normalizeLimits({
        a: 1,
        b: null,
        c: 'many',
        d: NaN,
        e: { nested: true },
      })
    ).toEqual({ a: 1, b: null });
    expect(normalizeLimits(null)).toEqual({});
    expect(normalizeLimits([1, 2])).toEqual({});
  });
});
