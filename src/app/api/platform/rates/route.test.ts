import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GET/POST /api/platform/rates (s10.2): Meta's rate card for the
// operator. The database is the in-memory fake.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
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
      h.failRead && table === 'meta_rates'
        ? {
            select: () => {
              const q = {
                order: () => q,
                then: (resolve: (v: unknown) => void) =>
                  resolve({
                    data: null,
                    error: { message: 'relation "meta_rates" leaked-detail' },
                  }),
              };
              return q;
            },
          }
        : h.db.admin.from(table),
  }),
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { OPERATOR, PLAIN_OWNER, seedRateTables } =
  await import('@/lib/platform/rates.test-support');
const { GET, POST } = await import('./route');

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/platform/rates', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

const NEW_RATE = {
  market: 'rest_of_latam',
  category: 'marketing',
  usd_per_message: 0.08,
  effective_from: '2027-01-01',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(seedRateTables());
  h.failRead = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await GET()).status).toBe(401);
  });

  it('403s a company owner and says nothing about the rates', async () => {
    h.user = { id: PLAIN_OWNER };
    const res = await GET();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('rest_of_latam');
  });

  it('lists the rates with which one is in force today', async () => {
    h.db.rows('meta_rates').push({
      market: 'rest_of_latam',
      category: 'marketing',
      usd_per_message: '0.08000',
      effective_from: '2027-01-01',
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.today).toBe('2026-11-15');
    const marketing = body.rates.filter(
      (r: { category: string }) => r.category === 'marketing'
    );
    expect(marketing).toEqual([
      expect.objectContaining({
        effectiveFrom: '2027-01-01',
        usdPerMessage: 0.08,
        inForce: false,
        scheduled: true,
      }),
      expect.objectContaining({
        effectiveFrom: '2026-10-01',
        usdPerMessage: 0.074,
        inForce: true,
        scheduled: false,
      }),
    ]);
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
    expect((await post(NEW_RATE)).status).toBe(401);
    h.user = { id: PLAIN_OWNER };
    expect((await post(NEW_RATE)).status).toBe(403);
    expect(h.db.rows('meta_rates')).toHaveLength(3);
  });

  it('inserts a NEW row with its effective date and the operator, never touching the one in force', async () => {
    const before = h.db.rows('meta_rates').map((r) => ({ ...r }));
    const res = await post(NEW_RATE);
    expect(res.status).toBe(201);
    const { rate } = await res.json();
    expect(rate).toMatchObject({
      market: 'rest_of_latam',
      category: 'marketing',
      usdPerMessage: 0.08,
      effectiveFrom: '2027-01-01',
      scheduled: true,
    });
    const rows = h.db.rows('meta_rates');
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 3)).toEqual(before);
    expect(rows[3]).toMatchObject({ ...NEW_RATE, created_by: OPERATOR });
    // No UPDATE ever reaches meta_rates.
    expect(
      h.db.log.some(
        (e) =>
          e.table === 'meta_rates' && e.op !== 'insert' && e.op !== 'select'
      )
    ).toBe(false);
  });

  it('409s the same market, category and date (a rate is never edited)', async () => {
    const res = await post({ ...NEW_RATE, effective_from: '2026-10-01' });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('conflict');
    expect(h.db.rows('meta_rates')).toHaveLength(3);
  });

  it('409s a past date that would re-price delivered messages', async () => {
    const res = await post({ ...NEW_RATE, effective_from: '2026-11-01' });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('retroactive');
  });

  it('accepts a past date for a market that had no rate (Mexico, loaded late)', async () => {
    const res = await post({
      ...NEW_RATE,
      market: 'mexico',
      effective_from: '2026-10-01',
    });
    expect(res.status).toBe(201);
    expect((await res.json()).rate.inForce).toBe(true);
  });

  it.each([
    ['a rate of 0', { ...NEW_RATE, usd_per_message: 0 }],
    ['an unknown category', { ...NEW_RATE, category: 'sms' }],
    ['a bad market', { ...NEW_RATE, market: 'Resto LatAm' }],
    ['a bad date', { ...NEW_RATE, effective_from: '01/01/2027' }],
    ['an unknown field', { ...NEW_RATE, id: 'x' }],
  ])('400s %s', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(h.db.rows('meta_rates')).toHaveLength(3);
  });

  it('400s a body that is not JSON', async () => {
    expect((await post('{not json')).status).toBe(400);
  });
});
