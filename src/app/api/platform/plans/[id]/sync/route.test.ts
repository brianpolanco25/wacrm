import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/plans/[id]/sync (s9.3). The database is the
// in-memory fake that evaluates queries for real; PayPal is a mocked
// global `fetch` that records what PayPal would have received.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', async () => {
  const mod = await import('@/lib/security/fake-supabase');
  const forward = mod.forwardingClient(() => h.db.admin);
  return { supabaseAdmin: () => forward };
});

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { __resetPayPalForTests } = await import('@/lib/billing/paypal');
const support = await import('@/lib/billing/plan-admin.test-support');
const { POST } = await import('./route');

const { OPERATOR, PLAIN_OWNER, paypalFake, seedPlanTables } = support;

function call(id: string, body: unknown = { cycle: 'month' }) {
  return POST(
    new Request(`http://localhost/api/platform/plans/${id}/sync`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

function planRow(id: string) {
  return h.db.rows('plans').find((p) => p.id === id)!;
}

function history() {
  return h.db.rows('plan_provider_history');
}

let paypal: ReturnType<typeof paypalFake>;

function usePayPal(options: Parameters<typeof paypalFake>[0] = {}) {
  paypal = paypalFake(options);
  vi.stubGlobal('fetch', vi.fn(paypal.fetch));
}

beforeEach(() => {
  __resetPayPalForTests();
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(seedPlanTables());
  vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('PAYPAL_ENV', 'sandbox');
  vi.stubEnv('PAYPAL_PRODUCT_NAME', '');
  usePayPal({ products: [{ id: 'PROD-CAB', name: 'Cabbity CRM' }] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the guard', () => {
  it('401s without a session and touches nothing', async () => {
    h.user = null;
    expect((await call('pro')).status).toBe(401);
    expect(paypal.requests).toEqual([]);
  });

  it('403s a company owner — owning an account buys nothing here', async () => {
    h.user = { id: PLAIN_OWNER };
    const before = JSON.stringify(h.db.rows('plans'));
    expect((await call('pro')).status).toBe(403);
    expect(JSON.stringify(h.db.rows('plans'))).toBe(before);
    expect(history()).toEqual([]);
    expect(paypal.requests).toEqual([]);
  });
});

describe('validation', () => {
  it.each([[{}], [{ cycle: 'week' }], [null]])(
    '400s a body without a valid cycle (%j)',
    async (body) => {
      expect((await call('pro', body)).status).toBe(400);
    }
  );

  it('404s an unknown plan and a malformed id', async () => {
    expect((await call('nope')).status).toBe(404);
    expect((await call('Not A Slug')).status).toBe(404);
  });

  it('400s a free cycle: nothing free is published to PayPal', async () => {
    const res = await call('oculto', { cycle: 'month' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('no_price');
    expect(paypal.requests).toEqual([]);
  });

  it('400s a cycle without a price', async () => {
    expect((await call('oculto', { cycle: 'year' })).status).toBe(400);
  });

  it('503s with a clear message when PayPal is not configured', async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', '');
    const res = await call('pro');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('paypal_not_configured');
    expect(body.error).toMatch(/PAYPAL_CLIENT_ID/);
    expect(paypal.requests).toEqual([]);
    expect(planRow('pro').provider_plan_id_month).toBeNull();
  });
});

describe('cycle without a PayPal id → create', () => {
  it('creates the plan at PayPal, stores the id and records the price', async () => {
    const res = await call('pro', { cycle: 'month' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      synced: true,
      action: 'created',
      providerPlanId: 'P-NEW-1',
    });
    expect(body.plan.sync.month).toEqual({
      state: 'synced',
      providerPlanId: 'P-NEW-1',
      syncedPrice: '100.00',
    });

    // Reused the product by name, then created one plan.
    expect(paypal.apiCalls()).toEqual([
      'GET /v1/catalogs/products',
      'POST /v1/billing/plans',
    ]);
    const create = paypal.requests.find((r) => r.path === '/v1/billing/plans')!;
    expect(create.body).toMatchObject({
      product_id: 'PROD-CAB',
      name: 'Pro (monthly)',
      billing_cycles: [
        {
          frequency: { interval_unit: 'MONTH' },
          pricing_scheme: { fixed_price: { value: '100.00' } },
        },
      ],
    });
    expect(create.headers['PayPal-Request-Id']).toBe(
      'wacrm-sandbox-pro-month-10000-r0'
    );

    expect(planRow('pro').provider_plan_id_month).toBe('P-NEW-1');
    expect(planRow('pro').provider_plan_id_year).toBeNull();
    expect(history()).toEqual([
      expect.objectContaining({
        plan_id: 'pro',
        cycle: 'month',
        provider: 'paypal',
        provider_plan_id: 'P-NEW-1',
        price_usd: 100,
        provider_env: 'sandbox',
        created_by: OPERATOR,
      }),
    ]);
  });

  it('creates the product when PayPal has none by that name', async () => {
    usePayPal({ products: [] });
    expect((await call('pro', { cycle: 'year' })).status).toBe(200);
    expect(paypal.apiCalls()).toEqual([
      'GET /v1/catalogs/products',
      'POST /v1/catalogs/products',
      'POST /v1/billing/plans',
    ]);
    expect(planRow('pro').provider_plan_id_year).toBe('P-NEW-1');
    expect(history()[0]).toMatchObject({ cycle: 'year', price_usd: 1000 });
  });

  it('records the live environment when PAYPAL_ENV=live', async () => {
    vi.stubEnv('PAYPAL_ENV', 'live');
    await call('pro');
    expect(history()[0].provider_env).toBe('live');
    expect(paypal.requests[0].path).toBe('/v1/oauth2/token');
  });

  it('502s when PayPal refuses, and stores nothing', async () => {
    usePayPal({
      products: [{ id: 'PROD-CAB', name: 'Cabbity CRM' }],
      createPlanStatus: 422,
    });
    const res = await call('pro');
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('UNPROCESSABLE');
    expect(planRow('pro').provider_plan_id_month).toBeNull();
    expect(history()).toEqual([]);
  });
});

describe('cycle with an id at the same price → no-op', () => {
  it('answers { synced: true } without calling PayPal', async () => {
    planRow('pro').provider_plan_id_month = 'P-OLD';
    history().push({
      id: 'h-1',
      plan_id: 'pro',
      cycle: 'month',
      provider: 'paypal',
      provider_plan_id: 'P-OLD',
      price_usd: '100.00',
      provider_env: 'sandbox',
      created_at: '2026-02-01T00:00:00.000Z',
      replaced_at: null,
      replaced_by: null,
      created_by: null,
    });

    const res = await call('pro');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      synced: true,
      action: 'noop',
      providerPlanId: 'P-OLD',
    });
    expect(paypal.requests).toEqual([]);
    expect(history()).toHaveLength(1);
  });
});

describe('cycle with an id at another price → new PayPal plan', () => {
  beforeEach(() => {
    // Pro was published at 79; the catalogue now says 100 (like 065).
    planRow('pro').provider_plan_id_month = 'P-OLD';
    history().push({
      id: 'h-1',
      plan_id: 'pro',
      cycle: 'month',
      provider: 'paypal',
      provider_plan_id: 'P-OLD',
      price_usd: '79.00',
      provider_env: 'sandbox',
      created_at: '2026-02-01T00:00:00.000Z',
      replaced_at: null,
      replaced_by: null,
      created_by: null,
    });
  });

  it('creates a new plan, swaps the id and archives the old one', async () => {
    const res = await call('pro');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      synced: true,
      action: 'replaced',
      providerPlanId: 'P-NEW-1',
      previousProviderPlanId: 'P-OLD',
    });

    // PayPal: a create, never an update of the old plan.
    expect(paypal.apiCalls()).toEqual([
      'GET /v1/catalogs/products',
      'POST /v1/billing/plans',
    ]);
    expect(
      paypal.requests.find((r) => r.path === '/v1/billing/plans')!.headers[
        'PayPal-Request-Id'
      ]
    ).toBe('wacrm-sandbox-pro-month-10000-r1');

    expect(planRow('pro').provider_plan_id_month).toBe('P-NEW-1');
    const old = history().find((r) => r.id === 'h-1')!;
    const fresh = history().find((r) => r.provider_plan_id === 'P-NEW-1')!;
    expect(fresh).toMatchObject({ price_usd: 100, replaced_at: null });
    expect(old.replaced_by).toBe(fresh.id);
    expect(old.replaced_at).toEqual(expect.any(String));
    // The old row keeps the price its subscribers still pay.
    expect(old.price_usd).toBe('79.00');
    expect(body.plan.sync.month.state).toBe('synced');
  });

  it('does not touch any subscription (decision 5)', async () => {
    h.db.rows('subscriptions').push({
      account_id: 'acct-a',
      plan_id: 'pro',
      status: 'active',
      provider_subscription_id: 'I-SUB-1',
    });
    const before = JSON.stringify(h.db.rows('subscriptions'));
    await call('pro');
    expect(JSON.stringify(h.db.rows('subscriptions'))).toBe(before);
    expect(
      paypal.requests.some((r) => r.path.includes('/billing/subscriptions'))
    ).toBe(false);
    expect(h.db.log.some((e) => e.table === 'subscriptions')).toBe(false);
  });
});

describe('cycle with an id and no history → «verificar»', () => {
  beforeEach(() => {
    planRow('pro').provider_plan_id_month = 'P-BOOT';
  });

  it('reads the price back from PayPal and, when it matches, only records it', async () => {
    usePayPal({
      remotePlans: { 'P-BOOT': { unit: 'MONTH', value: '100.00' } },
    });
    const res = await call('pro');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      synced: true,
      action: 'noop',
      verified: true,
      providerPlanId: 'P-BOOT',
    });
    expect(paypal.apiCalls()).toEqual(['GET /v1/billing/plans/P-BOOT']);
    expect(history()).toEqual([
      expect.objectContaining({
        provider_plan_id: 'P-BOOT',
        price_usd: 100,
        replaced_at: null,
      }),
    ]);
  });

  it('when PayPal charges another price, records it and replaces the plan', async () => {
    usePayPal({
      products: [{ id: 'PROD-CAB', name: 'Cabbity CRM' }],
      remotePlans: { 'P-BOOT': { unit: 'MONTH', value: '79.00' } },
    });
    const res = await call('pro');
    expect(await res.json()).toMatchObject({
      action: 'replaced',
      previousProviderPlanId: 'P-BOOT',
      providerPlanId: 'P-NEW-1',
      verified: true,
    });
    const boot = history().find((r) => r.provider_plan_id === 'P-BOOT')!;
    const fresh = history().find((r) => r.provider_plan_id === 'P-NEW-1')!;
    expect(boot).toMatchObject({ price_usd: 79, replaced_by: fresh.id });
    expect(planRow('pro').provider_plan_id_month).toBe('P-NEW-1');
  });

  it('409s when PayPal does not know the id (other environment)', async () => {
    usePayPal({ remotePlans: {} });
    const res = await call('pro');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('paypal_unknown_plan');
    expect(history()).toEqual([]);
    expect(planRow('pro').provider_plan_id_month).toBe('P-BOOT');
  });

  it('502s when the PayPal plan is not of this cycle', async () => {
    usePayPal({ remotePlans: { 'P-BOOT': { unit: 'YEAR', value: '100.00' } } });
    const res = await call('pro');
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('paypal_unreadable');
  });
});
