import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same fake as entitlements.test.ts: a service-role client that records
// every query so the account_id filter can be asserted, plus an `rpc`
// recorder for `increment_usage`.
const h = vi.hoisted(() => ({
  state: {
    subscription: null as Record<string, unknown> | null,
    plans: {} as Record<string, Record<string, unknown>>,
    queries: [] as { table: string; filters: [string, unknown][] }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    rpcError: null as { message: string } | null,
    rpcThrows: false,
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
              error: null,
            });
          }
          if (table === 'plans') {
            const id = q.filters.find(([c]) => c === 'id')?.[1] as string;
            return Promise.resolve({
              data: h.state.plans[id] ?? null,
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args });
      if (h.state.rpcThrows) return Promise.reject(new Error('network down'));
      return Promise.resolve({ data: 1, error: h.state.rpcError });
    },
  }),
}));

import {
  AccountLockedError,
  BILLING_UPGRADE_PATH,
  FeatureNotAvailableError,
  PlanLimitError,
  QuotaExceededError,
  assertPlanFeature,
  assertStockLimit,
  assertWritable,
  billingErrorPayload,
  recordUsage,
} from './enforce';
import type { Entitlements } from './entitlements';

const ACCOUNT = 'acct-1';

const PRO = {
  id: 'pro',
  limits: { operators: 10, messages_out: 15000, retention_months: null },
  features: ['ai_autoreply', 'api', 'webhooks'],
};

const INICIO = {
  id: 'inicio',
  limits: { operators: 3, numbers: 1 },
  features: ['ai_autoreply'],
};

function entitlements(overrides: Partial<Entitlements> = {}): Entitlements {
  return {
    planId: 'pro',
    status: 'active',
    limits: { operators: 3, knowledge_documents: 10, retention_months: null },
    features: ['ai_autoreply'],
    readOnly: false,
    trialEndsAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  h.state.subscription = null;
  h.state.plans = { pro: PRO, inicio: INICIO };
  h.state.queries = [];
  h.state.rpcCalls = [];
  h.state.rpcError = null;
  h.state.rpcThrows = false;
});

// ============================================================
// §5 — the dunning ladder, in the permission layer.
// ============================================================
describe('assertWritable', () => {
  it('lets an active account write', async () => {
    h.state.subscription = {
      plan_id: 'pro',
      status: 'active',
      trial_ends_at: null,
      grace_until: null,
    };
    const e = await assertWritable(ACCOUNT);
    expect(e.status).toBe('active');
    expect(e.readOnly).toBe(false);
  });

  it.each([['suspended'], ['expired']])(
    'refuses a %s account with AccountLockedError',
    async (status) => {
      h.state.subscription = {
        plan_id: 'pro',
        status,
        trial_ends_at: null,
        grace_until: null,
      };
      await expect(assertWritable(ACCOUNT)).rejects.toBeInstanceOf(
        AccountLockedError
      );
      await assertWritable(ACCOUNT).catch((err: AccountLockedError) => {
        expect(err.subscriptionStatus).toBe(status);
        expect(err.status).toBe(403);
      });
    }
  );

  it('lets a past_due account write while the grace period holds', async () => {
    h.state.subscription = {
      plan_id: 'pro',
      status: 'past_due',
      trial_ends_at: null,
      grace_until: new Date(Date.now() + 86_400_000).toISOString(),
    };
    await expect(assertWritable(ACCOUNT)).resolves.toBeTruthy();
  });

  it('refuses a past_due account once the grace period has run out', async () => {
    h.state.subscription = {
      plan_id: 'pro',
      status: 'past_due',
      trial_ends_at: null,
      grace_until: new Date(Date.now() - 86_400_000).toISOString(),
    };
    await expect(assertWritable(ACCOUNT)).rejects.toBeInstanceOf(
      AccountLockedError
    );
  });

  it('lets a seeded trial write', async () => {
    // Migration 046 gives every account a `pro`/`trialing` row.
    h.state.subscription = {
      plan_id: 'pro',
      status: 'trialing',
      trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      grace_until: null,
    };
    await expect(assertWritable(ACCOUNT)).resolves.toBeTruthy();
  });

  it('reads the subscription of THIS account and no other (leak test)', async () => {
    await assertWritable('acct-victim').catch(() => {});
    const subQueries = h.state.queries.filter(
      (q) => q.table === 'subscriptions'
    );
    expect(subQueries).toHaveLength(1);
    expect(subQueries[0].filters).toContainEqual(['account_id', 'acct-victim']);
  });

  it('reuses entitlements it was handed instead of hitting the database', async () => {
    await assertWritable(ACCOUNT, entitlements());
    expect(h.state.queries).toHaveLength(0);
  });
});

// ============================================================
// §4 — plan features.
// ============================================================
describe('assertPlanFeature', () => {
  it('passes when the plan includes the feature', async () => {
    h.state.subscription = {
      plan_id: 'pro',
      status: 'active',
      trial_ends_at: null,
      grace_until: null,
    };
    await expect(assertPlanFeature(ACCOUNT, 'api')).resolves.toBeTruthy();
  });

  it('throws FeatureNotAvailableError naming the feature', async () => {
    h.state.subscription = {
      plan_id: 'inicio',
      status: 'active',
      trial_ends_at: null,
      grace_until: null,
    };
    await expect(assertPlanFeature(ACCOUNT, 'api')).rejects.toBeInstanceOf(
      FeatureNotAvailableError
    );
    await assertPlanFeature(ACCOUNT, 'api').catch(
      (err: FeatureNotAvailableError) => expect(err.feature).toBe('api')
    );
  });

  it('scopes its lookup to the account it was asked about (leak test)', async () => {
    await assertPlanFeature('acct-victim', 'api').catch(() => {});
    const subQueries = h.state.queries.filter(
      (q) => q.table === 'subscriptions'
    );
    expect(subQueries[0].filters).toContainEqual(['account_id', 'acct-victim']);
  });
});

// ============================================================
// §4 — stock limits (seats, numbers, documents).
// ============================================================
describe('assertStockLimit', () => {
  it('passes while the count fits under the cap', () => {
    expect(() =>
      assertStockLimit(entitlements(), 'operators', 2)
    ).not.toThrow();
  });

  it('fixes the boundary at used + n > limit', () => {
    // 3-seat plan: the third seat is the last one that fits.
    expect(() =>
      assertStockLimit(entitlements(), 'operators', 2, 1)
    ).not.toThrow();
    expect(() => assertStockLimit(entitlements(), 'operators', 3, 1)).toThrow(
      PlanLimitError
    );
    expect(() => assertStockLimit(entitlements(), 'operators', 2, 2)).toThrow(
      PlanLimitError
    );
  });

  it('carries the metric, the limit and what is already in use', () => {
    try {
      assertStockLimit(entitlements(), 'knowledge_documents', 10);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanLimitError);
      const e = err as PlanLimitError;
      expect(e.metric).toBe('knowledge_documents');
      expect(e.limit).toBe(10);
      expect(e.used).toBe(10);
      expect(e.status).toBe(402);
    }
  });

  it('never throws for a null (unlimited) cap', () => {
    expect(() =>
      assertStockLimit(entitlements(), 'retention_months', 9_999_999)
    ).not.toThrow();
  });

  it('never throws for a metric the plan says nothing about', () => {
    expect(() =>
      assertStockLimit(entitlements(), 'unicorns', 9_999_999)
    ).not.toThrow();
  });
});

// ============================================================
// Counting.
// ============================================================
describe('recordUsage', () => {
  it('calls the atomic RPC of migration 041 with the account, metric and delta', async () => {
    await recordUsage(ACCOUNT, 'messages_out', 3);
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'increment_usage',
        args: { p_account_id: ACCOUNT, p_metric: 'messages_out', p_delta: 3 },
      },
    ]);
  });

  it('charges the account it was given and no other (leak test)', async () => {
    await recordUsage('acct-a', 'messages_out', 1);
    await recordUsage('acct-b', 'messages_out', 1);
    expect(h.state.rpcCalls.map((c) => c.args.p_account_id)).toEqual([
      'acct-a',
      'acct-b',
    ]);
  });

  it('does nothing for a zero or negative delta', async () => {
    await recordUsage(ACCOUNT, 'broadcast_recipients', 0);
    await recordUsage(ACCOUNT, 'broadcast_recipients', -5);
    expect(h.state.rpcCalls).toHaveLength(0);
  });

  it('swallows an RPC error — a counter must not fail a delivered message', async () => {
    h.state.rpcError = { message: 'permission denied' };
    await expect(
      recordUsage(ACCOUNT, 'messages_out', 1)
    ).resolves.toBeUndefined();
  });

  it('swallows a thrown RPC too', async () => {
    h.state.rpcThrows = true;
    await expect(
      recordUsage(ACCOUNT, 'messages_out', 1)
    ).resolves.toBeUndefined();
  });
});

// ============================================================
// The wire shape — "qué límite se alcanzó y cómo ampliarlo".
// ============================================================
describe('billingErrorPayload', () => {
  it('renders a quota miss with metric, limit, used and the upgrade path', () => {
    const p = billingErrorPayload(
      new QuotaExceededError('messages_out', 3000, 3000)
    );
    expect(p).toMatchObject({
      code: 'quota_exceeded',
      metric: 'messages_out',
      limit: 3000,
      used: 3000,
      upgradeUrl: BILLING_UPGRADE_PATH,
      status: 402,
    });
    expect(p?.error).toMatch(/messages_out/);
    expect(p?.error).toMatch(/upgrade/i);
  });

  it('renders a stock limit', () => {
    const p = billingErrorPayload(new PlanLimitError('operators', 3, 3));
    expect(p).toMatchObject({
      code: 'plan_limit_reached',
      metric: 'operators',
      limit: 3,
      status: 402,
    });
  });

  it('renders a missing feature', () => {
    const p = billingErrorPayload(new FeatureNotAvailableError('webhooks'));
    expect(p).toMatchObject({
      code: 'feature_unavailable',
      feature: 'webhooks',
      status: 402,
    });
  });

  it('renders the read-only lock as 403 with the subscription status', () => {
    const p = billingErrorPayload(new AccountLockedError('suspended'));
    expect(p).toMatchObject({
      code: 'account_read_only',
      subscriptionStatus: 'suspended',
      status: 403,
      upgradeUrl: BILLING_UPGRADE_PATH,
    });
  });

  it('returns null for anything that is not a billing error', () => {
    expect(billingErrorPayload(new Error('boom'))).toBeNull();
    expect(billingErrorPayload(null)).toBeNull();
    expect(billingErrorPayload('nope')).toBeNull();
  });
});
