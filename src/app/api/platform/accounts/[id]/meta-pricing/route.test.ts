import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH /api/platform/accounts/[id]/meta-pricing (s10.3, «Precio de Meta
// gestionado»). In-memory fake database with TWO managed companies: the
// change lands on the company of the URL only, with the trail first.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  failAudit: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => {
    const client = h.db.admin;
    if (!h.failAudit) return client;
    return {
      ...client,
      from: (table: string) => {
        if (table !== 'impersonation_log') return client.from(table);
        const failed = { data: null, error: { message: 'down' } };
        const chain = {
          insert: () => chain,
          select: () => chain,
          single: async () => failed,
        };
        return chain;
      },
    };
  },
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, reset: 0 }),
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { PATCH } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const REASON = 'nuevo precio acordado por contrato';

const PRICING = {
  included_messages: 7000,
  fee_usd: 1036,
  overage: {
    service: { multiplier: 2.5 },
    utility: { multiplier: 2.5 },
    marketing: { multiplier: 2.5 },
    authentication: { multiplier: 2.5 },
    authentication_international: { multiplier: 2.5 },
  },
};

const NEW_PRICING = {
  ...PRICING,
  included_messages: 8000,
  overage: { ...PRICING.overage, marketing: { usd_per_message: 0.15 } },
};

function seed() {
  return {
    platform_admins: [
      { id: 'pa-1', user_id: OPERATOR, granted_at: null, note: 'test' },
    ],
    accounts: [
      { id: A, name: 'Company A', created_at: '2026-01-01T00:00:00.000Z' },
      { id: B, name: 'Company B', created_at: '2026-01-01T00:00:00.000Z' },
      { id: C, name: 'Company C', created_at: '2026-01-01T00:00:00.000Z' },
    ],
    subscriptions: [
      {
        // The fake targets updates by `id`.
        id: 'sub-a',
        account_id: A,
        plan_id: 'gestionado',
        provider: 'manual',
        status: 'active',
        provider_subscription_id: null,
        meta_billing: 'managed',
        meta_pricing: PRICING,
        payment_method: 'manual',
      },
      {
        // The fake targets updates by `id`.
        id: 'sub-b',
        account_id: B,
        plan_id: 'gestionado',
        provider: 'paypal',
        status: 'active',
        provider_subscription_id: 'I-B-LIVE',
        meta_billing: 'managed',
        meta_pricing: PRICING,
        payment_method: 'paypal',
      },
      {
        // The fake targets updates by `id`.
        id: 'sub-c',
        account_id: C,
        plan_id: 'pro',
        provider: 'paypal',
        status: 'active',
        provider_subscription_id: 'I-C',
        meta_billing: 'direct',
        meta_pricing: {},
        payment_method: null,
      },
    ],
    impersonation_log: [],
  };
}

function call(body: unknown, id = A) {
  return PATCH(
    new Request(`http://localhost/api/platform/accounts/${id}/meta-pricing`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

function sub(accountId: string) {
  return h.db.rows('subscriptions').find((r) => r.account_id === accountId)!;
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(seed());
  h.failAudit = false;
});

describe('the guard', () => {
  it('401s without a session', async () => {
    h.user = null;
    const before = JSON.stringify(h.db.tables);
    expect(
      (await call({ reason: REASON, metaPricing: NEW_PRICING })).status
    ).toBe(401);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it('403s a company owner, on his own company too', async () => {
    h.user = { id: PLAIN_OWNER };
    const before = JSON.stringify(h.db.tables);
    expect(
      (await call({ reason: REASON, metaPricing: NEW_PRICING })).status
    ).toBe(403);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });
});

describe('validation', () => {
  it.each([
    ['no reason', { metaPricing: NEW_PRICING }],
    ['a short reason', { reason: 'corto', metaPricing: NEW_PRICING }],
    ['nothing to change', { reason: REASON }],
    ['an empty price', { reason: REASON, metaPricing: {} }],
    [
      'a price with an unknown category',
      {
        reason: REASON,
        metaPricing: {
          ...PRICING,
          overage: { ...PRICING.overage, sms: { multiplier: 1 } },
        },
      },
    ],
    [
      'a negative fee',
      { reason: REASON, metaPricing: { ...PRICING, fee_usd: -1 } },
    ],
    ['an unknown method', { reason: REASON, paymentMethod: 'cash' }],
  ])('400s %s, and writes nothing', async (_label, body) => {
    const before = JSON.stringify(h.db.tables);
    expect((await call(body)).status).toBe(400);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it('404s a malformed id and a company that does not exist', async () => {
    expect(
      (await call({ reason: REASON, metaPricing: NEW_PRICING }, 'nope')).status
    ).toBe(404);
    expect(
      (
        await call(
          { reason: REASON, metaPricing: NEW_PRICING },
          'dddddddd-0000-4000-8000-000000000004'
        )
      ).status
    ).toBe(404);
  });
});

describe('changing the price', () => {
  it('200: changes A only, with before/after in the trail', async () => {
    const bBefore = JSON.stringify(sub(B));
    const cBefore = JSON.stringify(sub(C));
    const res = await call({ reason: REASON, metaPricing: NEW_PRICING });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accountId: A,
      changed: true,
      metaPricing: NEW_PRICING,
      paymentMethod: 'manual',
    });
    expect(sub(A).meta_pricing).toEqual(NEW_PRICING);
    expect(JSON.stringify(sub(B))).toBe(bBefore);
    expect(JSON.stringify(sub(C))).toBe(cBefore);

    const log = h.db.rows('impersonation_log');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: 'plan_override',
      account_id: A,
      account_name: 'Company A',
      actor_user_id: OPERATOR,
      reason: REASON,
      details: {
        kind: 'meta_pricing',
        before: { meta_pricing: PRICING, payment_method: 'manual' },
        after: { meta_pricing: NEW_PRICING, payment_method: 'manual' },
      },
    });
  });

  it('writes neither the trail nor the row when nothing changes', async () => {
    const res = await call({ reason: REASON, metaPricing: PRICING });
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(false);
    expect(h.db.rows('impersonation_log')).toEqual([]);
  });

  it('500s and changes nothing when the trail cannot be written', async () => {
    h.failAudit = true;
    const before = JSON.stringify(sub(A));
    expect(
      (await call({ reason: REASON, metaPricing: NEW_PRICING })).status
    ).toBe(500);
    expect(JSON.stringify(sub(A))).toBe(before);
  });

  it('409s a company Cabbity does not pay Meta for (direct)', async () => {
    const before = JSON.stringify(sub(C));
    const res = await call({ reason: REASON, metaPricing: NEW_PRICING }, C);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_managed');
    expect(JSON.stringify(sub(C))).toBe(before);
    expect(h.db.rows('impersonation_log')).toEqual([]);
  });
});

describe('changing the payment method', () => {
  it('409s manual while PayPal is still billing the fee (B)', async () => {
    const res = await call({ reason: REASON, paymentMethod: 'manual' }, B);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('paypal_active');
    expect(sub(B).payment_method).toBe('paypal');
  });

  it('409s paypal with no live PayPal subscription (A): assign the plan with PayPal', async () => {
    const res = await call({ reason: REASON, paymentMethod: 'paypal' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('needs_checkout');
    expect(sub(A).payment_method).toBe('manual');
  });

  it('moves to manual once PayPal no longer bills (cancelled)', async () => {
    sub(B).status = 'cancelled';
    const res = await call({ reason: REASON, paymentMethod: 'manual' }, B);
    expect(res.status).toBe(200);
    expect(sub(B).payment_method).toBe('manual');
    expect(sub(A).payment_method).toBe('manual');
    expect(h.db.rows('impersonation_log')[0]).toMatchObject({
      account_id: B,
      details: {
        before: { payment_method: 'paypal' },
        after: { payment_method: 'manual' },
      },
    });
  });
});
