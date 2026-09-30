import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH /api/platform/plans/[id] (s9.3): edit a plan; the id never
// changes and nothing here talks to PayPal.

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
const support = await import('@/lib/billing/plan-admin.test-support');
const routeModule = await import('./route');
const { PATCH } = routeModule;

const { FULL_LIMITS, OPERATOR, PLAIN_OWNER, seedPlanTables } = support;

function patch(id: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/platform/plans/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

function pro() {
  return h.db.rows('plans').find((p) => p.id === 'pro')!;
}

const fetchSpy = vi.fn();

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(seedPlanTables());
  vi.stubGlobal('fetch', fetchSpy);
});

describe('the guard', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await patch('pro', { name: 'X' })).status).toBe(401);
    expect(pro().name).toBe('Pro');
  });

  it('403s a company owner and leaves plans untouched', async () => {
    h.user = { id: PLAIN_OWNER };
    const before = JSON.stringify(h.db.rows('plans'));
    expect(
      (await patch('pro', { price_usd_month: 1, is_public: false })).status
    ).toBe(403);
    expect(JSON.stringify(h.db.rows('plans'))).toBe(before);
  });
});

describe('editing', () => {
  it('updates the fields sent and nothing else', async () => {
    const res = await patch('pro', {
      name: 'Pro+',
      is_public: false,
      sort_order: 7,
      description: 'Nuevo',
      features: ['priority_support', 'api'],
      limits: { ...FULL_LIMITS, operators: null },
    });
    expect(res.status).toBe(200);
    const { plan } = await res.json();
    expect(plan).toMatchObject({
      id: 'pro',
      name: 'Pro+',
      isPublic: false,
      sortOrder: 7,
      description: 'Nuevo',
      features: ['api', 'priority_support'],
      priceMonth: 100,
    });
    expect(pro().limits).toEqual({ ...FULL_LIMITS, operators: null });
    expect(pro().price_usd_year).toBe(1000);
  });

  it('a price edit shows «precio desincronizado» and does not call PayPal', async () => {
    pro().provider_plan_id_month = 'P-PRO-M';
    h.db.rows('plan_provider_history').push({
      id: 'h-1',
      plan_id: 'pro',
      cycle: 'month',
      provider: 'paypal',
      provider_plan_id: 'P-PRO-M',
      price_usd: '100.00',
      provider_env: 'sandbox',
      created_at: '2026-02-01T00:00:00.000Z',
      replaced_at: null,
    });

    const { plan } = await (
      await patch('pro', { price_usd_month: 120 })
    ).json();
    expect(plan.sync.month).toMatchObject({
      state: 'price_mismatch',
      syncedPrice: '100.00',
    });
    expect(pro().provider_plan_id_month).toBe('P-PRO-M');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('400s any attempt to change the id', async () => {
    expect((await patch('pro', { id: 'pro2' })).status).toBe(400);
    expect(h.db.rows('plans').some((p) => p.id === 'pro2')).toBe(false);
  });

  it('400s invalid limits, features and PayPal ids', async () => {
    for (const body of [
      { limits: { ...FULL_LIMITS, operators: 1.5 } },
      { limits: { ...FULL_LIMITS, bananas: 1 } },
      { features: ['api', 'nope'] },
      { provider_plan_id_month: 'P-HACK' },
      {},
    ]) {
      expect((await patch('pro', body)).status).toBe(400);
    }
    expect(pro().provider_plan_id_month).toBeNull();
  });

  it('404s a plan that does not exist, and a malformed id', async () => {
    expect((await patch('nope', { name: 'X' })).status).toBe(404);
    expect((await patch('NO PE', { name: 'X' })).status).toBe(404);
  });

  it('has no DELETE: a plan is unpublished, not deleted', () => {
    expect('DELETE' in routeModule).toBe(false);
  });
});
