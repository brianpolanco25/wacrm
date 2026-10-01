import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/accounts/[id]/plan with the managed plan (s10.3).
// The database is the in-memory fake that evaluates queries for real,
// seeded with TWO companies; PayPal is a mocked global `fetch` that
// records what PayPal would have received. No network.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

// The fake does not enforce indexes; the one that matters here is 048's
// UNIQUE (provider, provider_subscription_id) on `checkout_intents`, so a
// second intent for the same PayPal subscription answers 23505 like
// PostgREST.
vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const query = h.db.admin.from(table);
      if (table !== 'checkout_intents') return query;
      return new Proxy(query, {
        get(target, prop, receiver) {
          if (prop !== 'insert') return Reflect.get(target, prop, receiver);
          return (row: Record<string, unknown>) => {
            const clash = h.db
              .rows('checkout_intents')
              .some(
                (r) =>
                  r.provider === row.provider &&
                  r.provider_subscription_id === row.provider_subscription_id
              );
            if (!clash) return target.insert(row);
            const failed = { data: null, error: { code: '23505' } };
            const chain = {
              select: () => chain,
              single: async () => failed,
              then: (resolve: (v: unknown) => unknown) => resolve(failed),
            };
            return chain;
          };
        },
      });
    },
  }),
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, reset: 0 }),
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { __resetPayPalForTests } = await import('@/lib/billing/paypal');
const support = await import('@/lib/billing/plan-admin.test-support');
const { POST } = await import('./route');

const { OPERATOR, PLAIN_OWNER, paypalFake, seedPlanTables, FULL_LIMITS } =
  support;

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const REASON = 'cliente gestionado: contrato 2026-10';

const DEFAULT_PRICING = {
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

function seed() {
  const tables = seedPlanTables();
  tables.plans.push({
    id: 'gestionado',
    name: 'Gestionado',
    description: null,
    price_usd_month: 1036,
    price_usd_year: null,
    limits: { ...FULL_LIMITS, messages_out: null, broadcast_recipients: null },
    features: ['ai_autoreply'],
    is_public: false,
    sort_order: 90,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    provider_plan_id_month: null,
    provider_plan_id_year: null,
    meta_pricing: DEFAULT_PRICING,
  });
  for (const plan of tables.plans) plan.meta_pricing ??= {};
  tables.accounts = [
    { id: A, name: 'Company A', created_at: '2026-01-01T00:00:00.000Z' },
    { id: B, name: 'Company B', created_at: '2026-01-01T00:00:00.000Z' },
  ];
  tables.subscriptions = [
    {
      // The fake targets updates by `id`.
      id: 'sub-a',
      account_id: A,
      plan_id: 'inicio',
      provider: 'paypal',
      status: 'incomplete',
      provider_subscription_id: null,
      meta_billing: 'direct',
      meta_pricing: {},
      payment_method: null,
    },
    {
      // The fake targets updates by `id`.
      id: 'sub-b',
      account_id: B,
      plan_id: 'pro',
      provider: 'paypal',
      status: 'active',
      provider_subscription_id: 'I-B-LIVE',
      cycle: 'month',
      current_period_end: '2026-10-20T00:00:00.000Z',
      meta_billing: 'direct',
      meta_pricing: {},
      payment_method: null,
    },
  ];
  tables.checkout_intents = [];
  tables.impersonation_log = [];
  return tables;
}

let paypal: ReturnType<typeof paypalFake>;

/**
 * Status PayPal reports for a subscription on `GET`, by id (default
 * APPROVAL_PENDING; `'404'` answers RESOURCE_NOT_FOUND).
 */
let remoteStatus: Record<string, string> = {};

/**
 * `paypalFake` plus the subscription calls. Like PayPal, a POST with a
 * `PayPal-Request-Id` already seen replays the SAME subscription and
 * link instead of minting a new one.
 */
function usePayPal(options: { subscriptionStatus?: number } = {}) {
  paypal = paypalFake({ products: [{ id: 'PROD-CAB', name: 'Cabbity CRM' }] });
  let minted = 0;
  const byRequestId = new Map<string, number>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const subscriptionBody = (n: number, status: string) => ({
    id: `I-NEW-${n}`,
    status,
    links:
      status === 'APPROVAL_PENDING'
        ? [
            {
              rel: 'approve',
              href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${n}`,
            },
          ]
        : [],
  });
  const base = paypal.fetch;
  const fetchImpl = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(String(input));
    const read = /^\/v1\/billing\/subscriptions\/([^/]+)$/.exec(url.pathname);
    if (read && (init.method ?? 'GET') === 'GET') {
      const id = decodeURIComponent(read[1]);
      paypal.requests.push({
        method: 'GET',
        path: url.pathname,
        body: null,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      const status = remoteStatus[id] ?? 'APPROVAL_PENDING';
      if (status === '404') return json({ name: 'RESOURCE_NOT_FOUND' }, 404);
      return json(subscriptionBody(Number(id.replace('I-NEW-', '')), status));
    }
    if (
      url.pathname === '/v1/billing/subscriptions' &&
      init.method === 'POST'
    ) {
      const body = JSON.parse(String(init.body));
      paypal.requests.push({
        method: 'POST',
        path: url.pathname,
        body,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      if (options.subscriptionStatus) {
        return new Response(JSON.stringify({ name: 'UNPROCESSABLE' }), {
          status: options.subscriptionStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const key = (init.headers as Record<string, string>)['PayPal-Request-Id'];
      let n = key ? byRequestId.get(key) : undefined;
      if (n === undefined) {
        minted += 1;
        n = minted;
        if (key) byRequestId.set(key, n);
      }
      return json(subscriptionBody(n, 'APPROVAL_PENDING'), 201);
    }
    return base(input, init);
  };
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
}

function call(body: unknown, id = A) {
  return POST(
    new Request(`http://localhost/api/platform/accounts/${id}/plan`, {
      method: 'POST',
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
  __resetPayPalForTests();
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(seed());
  remoteStatus = {};
  vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('PAYPAL_ENV', 'sandbox');
  vi.stubEnv('PAYPAL_PRODUCT_NAME', '');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.cabbity.test');
  usePayPal();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the guard', () => {
  it('401s without a session, and nothing moves', async () => {
    h.user = null;
    const before = JSON.stringify(h.db.tables);
    const res = await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'paypal',
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(h.db.tables)).toBe(before);
    expect(paypal.requests).toEqual([]);
  });

  it('403s a company owner — on his own company too — and nothing moves', async () => {
    h.user = { id: PLAIN_OWNER };
    const before = JSON.stringify(h.db.tables);
    const res = await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'manual',
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(h.db.tables)).toBe(before);
    expect(paypal.requests).toEqual([]);
  });
});

describe('validation', () => {
  it.each([
    ['an unknown payment method', { paymentMethod: 'cash' }],
    ['an unknown meta billing', { paymentMethod: 'manual', metaBilling: 'x' }],
    [
      'a price with a category missing',
      {
        paymentMethod: 'manual',
        metaPricing: {
          ...DEFAULT_PRICING,
          overage: { marketing: { multiplier: 2.5 } },
        },
      },
    ],
    [
      'a multiplier of 0',
      {
        paymentMethod: 'manual',
        metaPricing: {
          ...DEFAULT_PRICING,
          overage: { ...DEFAULT_PRICING.overage, marketing: { multiplier: 0 } },
        },
      },
    ],
    [
      'a fee with three decimals',
      {
        paymentMethod: 'paypal',
        metaPricing: { ...DEFAULT_PRICING, fee_usd: 10.123 },
      },
    ],
    [
      'an empty price while Cabbity pays Meta',
      { paymentMethod: 'manual', metaPricing: {} },
    ],
  ])('400s %s, and writes nothing', async (_label, extra) => {
    const before = JSON.stringify(h.db.tables);
    const res = await call({ planId: 'gestionado', reason: REASON, ...extra });
    expect(res.status).toBe(400);
    expect(JSON.stringify(h.db.tables)).toBe(before);
    expect(paypal.requests).toEqual([]);
  });

  it('400s the managed plan given blind (no payment method): needs_terms', async () => {
    const res = await call({ planId: 'gestionado', reason: REASON });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('needs_terms');
    expect(h.db.rows('impersonation_log')).toEqual([]);
    expect(sub(A).plan_id).toBe('inicio');
  });

  it('400s PayPal for a plan without a price policy: the company contracts that one itself', async () => {
    const res = await call({
      planId: 'pro',
      reason: REASON,
      paymentMethod: 'paypal',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('not_managed_plan');
    expect(paypal.requests).toEqual([]);
  });
});

describe('manual', () => {
  it('200: manual, active, monthly, cut-off in a month, the price stored — company A only', async () => {
    const bBefore = JSON.stringify(sub(B));
    const res = await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'manual',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      accountId: A,
      planId: 'gestionado',
      provider: 'manual',
      status: 'active',
      paymentMethod: 'manual',
    });

    const row = sub(A);
    expect(row).toMatchObject({
      plan_id: 'gestionado',
      provider: 'manual',
      status: 'active',
      cycle: 'month',
      payment_method: 'manual',
      meta_billing: 'managed',
      meta_pricing: DEFAULT_PRICING,
      provider_subscription_id: null,
    });
    const end = Date.parse(row.current_period_end as string);
    const days = (end - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);

    // B untouched; PayPal never called.
    expect(JSON.stringify(sub(B))).toBe(bBefore);
    expect(paypal.requests).toEqual([]);

    const log = h.db.rows('impersonation_log');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: 'plan_override',
      account_id: A,
      actor_user_id: OPERATOR,
      reason: REASON,
    });
    expect(log[0].details).toMatchObject({
      to_plan: 'gestionado',
      payment_method: 'manual',
      meta_billing: 'managed',
      meta_pricing: DEFAULT_PRICING,
    });
  });

  it('stores an edited price (fixed USD for marketing) instead of the default', async () => {
    const edited = {
      ...DEFAULT_PRICING,
      included_messages: 5000,
      overage: {
        ...DEFAULT_PRICING.overage,
        marketing: { usd_per_message: 0.2 },
      },
    };
    const res = await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'manual',
      metaPricing: edited,
    });
    expect(res.status).toBe(200);
    expect(sub(A).meta_pricing).toEqual(edited);
  });

  it('unticked «Meta lo paga Cabbity»: direct and no price', async () => {
    const res = await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'manual',
      metaBilling: 'direct',
    });
    expect(res.status).toBe(200);
    expect(sub(A)).toMatchObject({ meta_billing: 'direct', meta_pricing: {} });
  });

  it('409s company B, which PayPal is still billing, and changes nothing', async () => {
    const before = JSON.stringify(sub(B));
    const res = await call(
      { planId: 'gestionado', reason: REASON, paymentMethod: 'manual' },
      B
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(sub(B))).toBe(before);
    expect(h.db.rows('impersonation_log')).toEqual([]);
  });

  it('a plan with no price policy afterwards takes the company out of managed billing', async () => {
    await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'manual',
    });
    const res = await call({ planId: 'pro', reason: REASON });
    expect(res.status).toBe(200);
    expect(sub(A)).toMatchObject({
      plan_id: 'pro',
      meta_billing: 'direct',
      meta_pricing: {},
      payment_method: null,
      cycle: null,
      current_period_end: null,
    });
  });
});

describe('paypal', () => {
  it('200: publishes the hidden plan, creates the subscription for A, leaves A incomplete, hands back the link', async () => {
    const bBefore = JSON.stringify(sub(B));
    const res = await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'paypal',
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      accountId: A,
      planId: 'gestionado',
      provider: 'paypal',
      status: 'incomplete',
      paymentMethod: 'paypal',
      subscriptionId: 'I-NEW-1',
      published: true,
    });
    expect(json.approvalUrl).toContain('ba_token=BA-1');

    // PayPal: the plan was created (monthly, 1036) and then the subscription.
    expect(paypal.apiCalls()).toEqual([
      'GET /v1/catalogs/products',
      'POST /v1/billing/plans',
      'POST /v1/billing/subscriptions',
    ]);
    const createdPlan = paypal.requests.find(
      (r) => r.path === '/v1/billing/plans'
    )!;
    expect(JSON.stringify(createdPlan.body)).toContain('1036.00');
    const subscribe = paypal.requests.find(
      (r) => r.path === '/v1/billing/subscriptions'
    )!;
    expect(subscribe.body).toMatchObject({
      plan_id: 'P-NEW-1',
      custom_id: A,
      application_context: {
        return_url: 'https://app.cabbity.test/onboarding/return',
      },
    });
    expect(subscribe.headers['PayPal-Request-Id']).toMatch(
      new RegExp(`^checkout-${A}-gestionado-month-`)
    );

    // The catalogue now knows the PayPal plan (s9.3 history row).
    const plan = h.db.rows('plans').find((p) => p.id === 'gestionado')!;
    expect(plan.provider_plan_id_month).toBe('P-NEW-1');
    expect(h.db.rows('plan_provider_history')).toHaveLength(1);

    // The intent the webhook resolves the account with.
    expect(h.db.rows('checkout_intents')).toEqual([
      expect.objectContaining({
        account_id: A,
        plan_id: 'gestionado',
        cycle: 'month',
        provider: 'paypal',
        provider_plan_id: 'P-NEW-1',
        provider_subscription_id: 'I-NEW-1',
        status: 'pending',
        created_by: OPERATOR,
      }),
    ]);

    // A is unpaid until PayPal confirms; B never moved.
    expect(sub(A)).toMatchObject({
      plan_id: 'gestionado',
      provider: 'paypal',
      status: 'incomplete',
      provider_subscription_id: null,
      cycle: 'month',
      payment_method: 'paypal',
      meta_billing: 'managed',
      meta_pricing: DEFAULT_PRICING,
    });
    expect(JSON.stringify(sub(B))).toBe(bBefore);

    const log = h.db.rows('impersonation_log');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'plan_override', account_id: A });
    expect(log[0].details).toMatchObject({
      payment_method: 'paypal',
      meta_billing: 'managed',
      meta_pricing: DEFAULT_PRICING,
      provider_subscription_id: 'I-NEW-1',
      paypal_plan_published: true,
    });
  });

  it('reuses the PayPal plan when it already exists (no second publication)', async () => {
    const plan = h.db.rows('plans').find((p) => p.id === 'gestionado')!;
    plan.provider_plan_id_month = 'P-EXISTING';
    const res = await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'paypal',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).published).toBe(false);
    expect(paypal.apiCalls()).toEqual(['POST /v1/billing/subscriptions']);
    expect(h.db.rows('checkout_intents')[0].provider_plan_id).toBe(
      'P-EXISTING'
    );
  });

  describe('repeating it (idempotency)', () => {
    const BODY = {
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'paypal',
    };
    const subscriptionPosts = () =>
      paypal.requests.filter(
        (r) => r.method === 'POST' && r.path === '/v1/billing/subscriptions'
      );

    afterEach(() => {
      vi.useRealTimers();
    });

    it('twice in a row (double click): one subscription, one intent, the same link', async () => {
      const first = await (await call(BODY)).json();
      const second = await call(BODY);
      expect(second.status).toBe(200);
      const again = await second.json();

      expect(again.subscriptionId).toBe(first.subscriptionId);
      expect(again.approvalUrl).toBe(first.approvalUrl);
      expect(again.reused).toBe(true);
      expect(subscriptionPosts()).toHaveLength(1);
      expect(h.db.rows('checkout_intents')).toHaveLength(1);
      expect(h.db.rows('checkout_intents')[0]).toMatchObject({
        account_id: A,
        provider_subscription_id: 'I-NEW-1',
        status: 'pending',
      });
      expect(
        h.db.rows('subscriptions').filter((r) => r.account_id === A)
      ).toHaveLength(1);
      expect(sub(A)).toMatchObject({
        status: 'incomplete',
        plan_id: 'gestionado',
      });
      // The plan is published once, too.
      expect(h.db.rows('plan_provider_history')).toHaveLength(1);
    });

    it('hours later, past the ten-minute PayPal-Request-Id bucket: still no second subscription', async () => {
      vi.useFakeTimers({
        toFake: ['Date'],
        now: new Date('2026-10-01T10:00:00Z'),
      });
      const first = await (await call(BODY)).json();
      vi.setSystemTime(new Date('2026-10-01T13:00:00Z'));
      const again = await (await call(BODY)).json();

      expect(again.subscriptionId).toBe(first.subscriptionId);
      expect(again.approvalUrl).toBe(first.approvalUrl);
      expect(subscriptionPosts()).toHaveLength(1);
      expect(h.db.rows('checkout_intents')).toHaveLength(1);
    });

    it('a pending link PayPal let expire is closed and a new one opened', async () => {
      vi.useFakeTimers({
        toFake: ['Date'],
        now: new Date('2026-10-01T10:00:00Z'),
      });
      await call(BODY);
      remoteStatus['I-NEW-1'] = 'EXPIRED';
      vi.setSystemTime(new Date('2026-10-04T10:00:00Z'));
      const again = await (await call(BODY)).json();

      expect(again.subscriptionId).toBe('I-NEW-2');
      expect(again.reused).toBe(false);
      expect(subscriptionPosts()).toHaveLength(2);
      const intents = h.db.rows('checkout_intents');
      expect(intents).toHaveLength(2);
      expect(
        intents.find((r) => r.provider_subscription_id === 'I-NEW-1')?.status
      ).toBe('cancelled');
      expect(
        intents.find((r) => r.provider_subscription_id === 'I-NEW-2')?.status
      ).toBe('pending');
    });

    it('a subscription PayPal no longer knows (404) counts as gone', async () => {
      await call(BODY);
      remoteStatus['I-NEW-1'] = '404';
      vi.useFakeTimers({
        toFake: ['Date'],
        now: new Date(Date.now() + 86_400_000),
      });
      const again = await (await call(BODY)).json();
      expect(again.subscriptionId).toBe('I-NEW-2');
      expect(subscriptionPosts()).toHaveLength(2);
    });

    it('409s once the owner already approved it (webhook on its way), and creates nothing', async () => {
      await call(BODY);
      remoteStatus['I-NEW-1'] = 'ACTIVE';
      const before = JSON.stringify(h.db.tables);
      const res = await call(BODY);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('checkout_in_progress');
      expect(subscriptionPosts()).toHaveLength(1);
      expect(JSON.stringify(h.db.tables)).toBe(before);
    });

    it("another company's pending checkout is never reused (A↔B)", async () => {
      h.db.rows('checkout_intents').push({
        id: 'intent-b',
        account_id: B,
        plan_id: 'gestionado',
        cycle: 'month',
        provider: 'paypal',
        provider_plan_id: 'P-OTHER',
        provider_subscription_id: 'I-B-PENDING',
        status: 'pending',
        created_at: '2026-09-30T00:00:00.000Z',
      });
      const res = await (await call(BODY)).json();
      expect(res.subscriptionId).toBe('I-NEW-1');
      expect(res.reused).toBe(false);
      expect(paypal.requests.some((r) => r.path.endsWith('/I-B-PENDING'))).toBe(
        false
      );
      expect(
        h.db.rows('checkout_intents').find((r) => r.id === 'intent-b')?.status
      ).toBe('pending');
    });
  });

  it('502s when PayPal refuses the subscription: no trail, no intent, A unchanged', async () => {
    usePayPal({ subscriptionStatus: 422 });
    const before = JSON.stringify(sub(A));
    const res = await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'paypal',
    });
    expect(res.status).toBe(502);
    expect(JSON.stringify(sub(A))).toBe(before);
    expect(h.db.rows('checkout_intents')).toEqual([]);
    expect(h.db.rows('impersonation_log')).toEqual([]);
  });

  it('503s without PayPal credentials, and nothing moves', async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', '');
    const before = JSON.stringify(h.db.tables);
    const res = await call({
      planId: 'gestionado',
      reason: REASON,
      paymentMethod: 'paypal',
    });
    expect(res.status).toBe(503);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it('409s company B (PayPal still billing) before calling PayPal', async () => {
    const res = await call(
      { planId: 'gestionado', reason: REASON, paymentMethod: 'paypal' },
      B
    );
    expect(res.status).toBe(409);
    expect(paypal.requests).toEqual([]);
  });
});
