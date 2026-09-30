import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GET/POST /api/platform/plans (s9.3): the whole catalogue for the
// operator, and creating a plan. The database is the in-memory fake.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  duplicateInsert: false,
  failRead: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) =>
      h.failRead && table === 'plans'
        ? {
            select: () => ({
              order: async () => ({
                data: null,
                error: { message: 'relation "plans" leaked-detail' },
              }),
            }),
          }
        : h.duplicateInsert && table === 'plans'
          ? {
              // What PostgREST answers for a primary-key collision.
              insert: () => ({
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: '23505', message: 'duplicate key' },
                  }),
                }),
              }),
            }
          : h.db.admin.from(table),
  }),
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const support = await import('@/lib/billing/plan-admin.test-support');
const { GET, POST } = await import('./route');

const { FULL_LIMITS, OPERATOR, PLAIN_OWNER, seedPlanTables } = support;

const NEW_PLAN = {
  id: 'plus',
  name: 'Plus',
  price_usd_month: 49,
  price_usd_year: 490,
  limits: { ...FULL_LIMITS, retention_months: null },
  features: ['webhooks', 'api'],
  is_public: false,
  sort_order: 5,
  description: 'Equipos medianos',
};

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/platform/plans', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(seedPlanTables());
  h.duplicateInsert = false;
  h.failRead = false;
  vi.stubEnv('PAYPAL_ENV', 'sandbox');
  vi.stubEnv('PAYPAL_CLIENT_ID', 'id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await GET()).status).toBe(401);
  });

  it('403s a company owner', async () => {
    h.user = { id: PLAIN_OWNER };
    const res = await GET();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('Inicio');
  });

  it('lists every plan, public or not, in sort order, with the PayPal env', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerEnv).toBe('sandbox');
    expect(body.paypalConfigured).toBe(true);
    expect(body.plans.map((p: { id: string }) => p.id)).toEqual([
      'inicio',
      'pro',
      'oculto',
    ]);
    expect(body.plans[2]).toMatchObject({ isPublic: false, priceMonth: 0 });
  });

  it('says live when PAYPAL_ENV=live and flags missing credentials', async () => {
    vi.stubEnv('PAYPAL_ENV', 'live');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', '');
    const body = await (await GET()).json();
    expect(body.providerEnv).toBe('live');
    expect(body.paypalConfigured).toBe(false);
  });

  it('reports the sync state per cycle: unpublished, synced, price mismatch, unknown', async () => {
    const plans = h.db.rows('plans');
    const inicio = plans.find((p) => p.id === 'inicio')!;
    const pro = plans.find((p) => p.id === 'pro')!;
    inicio.provider_plan_id_month = 'P-INI-M'; // no history → unknown
    pro.provider_plan_id_month = 'P-PRO-M'; // created at 79, now 100
    pro.provider_plan_id_year = 'P-PRO-Y'; // created at 1000
    h.db.rows('plan_provider_history').push(
      {
        id: 'h-1',
        plan_id: 'pro',
        cycle: 'month',
        provider: 'paypal',
        provider_plan_id: 'P-PRO-M',
        price_usd: '79.00',
        provider_env: 'sandbox',
        created_at: '2026-02-01T00:00:00.000Z',
        replaced_at: null,
      },
      {
        id: 'h-2',
        plan_id: 'pro',
        cycle: 'year',
        provider: 'paypal',
        provider_plan_id: 'P-PRO-Y',
        price_usd: '1000.00',
        provider_env: 'sandbox',
        created_at: '2026-02-01T00:00:00.000Z',
        replaced_at: null,
      }
    );

    const body = await (await GET()).json();
    const byId = Object.fromEntries(
      body.plans.map((p: { id: string }) => [p.id, p])
    );
    expect(byId.inicio.sync.month.state).toBe('unknown');
    expect(byId.inicio.sync.year.state).toBe('unpublished');
    expect(byId.pro.sync.month).toEqual({
      state: 'price_mismatch',
      providerPlanId: 'P-PRO-M',
      syncedPrice: '79.00',
    });
    expect(byId.pro.sync.year.state).toBe('synced');
    expect(byId.pro.history).toHaveLength(2);
    expect(byId.inicio.history).toEqual([]);
  });

  it('500s without echoing the database error', async () => {
    h.failRead = true;
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('leaked-detail');
  });
});

describe('POST', () => {
  it('401s and 403s without writing', async () => {
    h.user = null;
    expect((await post(NEW_PLAN)).status).toBe(401);
    h.user = { id: PLAIN_OWNER };
    expect((await post(NEW_PLAN)).status).toBe(403);
    expect(h.db.rows('plans').map((p) => p.id)).toEqual([
      'inicio',
      'pro',
      'oculto',
    ]);
  });

  it('creates a plan with no PayPal id and answers 201', async () => {
    const res = await post(NEW_PLAN);
    expect(res.status).toBe(201);
    const { plan } = await res.json();
    expect(plan).toMatchObject({
      id: 'plus',
      name: 'Plus',
      priceMonth: 49,
      priceYear: 490,
      isPublic: false,
      sortOrder: 5,
      description: 'Equipos medianos',
      features: ['api', 'webhooks'],
      sync: {
        month: { state: 'unpublished' },
        year: { state: 'unpublished' },
      },
    });
    const row = h.db.rows('plans').find((p) => p.id === 'plus')!;
    expect(row.limits).toEqual({ ...FULL_LIMITS, retention_months: null });
    expect(row.provider_plan_id_month).toBeUndefined();
  });

  it.each([
    ['a bad slug', { ...NEW_PLAN, id: 'Plus Plan' }],
    [
      'an unknown metric',
      { ...NEW_PLAN, limits: { ...FULL_LIMITS, seats: 1 } },
    ],
    [
      'a negative limit',
      { ...NEW_PLAN, limits: { ...FULL_LIMITS, numbers: -1 } },
    ],
    ['a missing metric', { ...NEW_PLAN, limits: { operators: 1 } }],
    ['an unknown feature', { ...NEW_PLAN, features: ['teleport'] }],
    ['a PayPal id', { ...NEW_PLAN, provider_plan_id_month: 'P-X' }],
    ['no name', { ...NEW_PLAN, name: '' }],
  ])('400s %s', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(h.db.rows('plans')).toHaveLength(3);
  });

  it('400s a body that is not JSON', async () => {
    expect((await post('{not json')).status).toBe(400);
  });

  it('409s an id that already exists', async () => {
    h.duplicateInsert = true;
    const res = await post({ ...NEW_PLAN, id: 'pro' });
    expect(res.status).toBe(409);
  });
});
