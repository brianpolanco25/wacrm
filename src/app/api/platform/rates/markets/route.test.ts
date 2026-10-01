import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET/PUT /api/platform/rates/markets (s10.2): the country → market
// table. The database is the in-memory fake.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { OPERATOR, PLAIN_OWNER, seedRateTables } =
  await import('@/lib/platform/rates.test-support');
const { GET, PUT } = await import('./route');

function put(body: unknown) {
  return PUT(
    new Request('http://localhost/api/platform/rates/markets', {
      method: 'PUT',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(seedRateTables());
});

describe('GET', () => {
  it('401s without a session and 403s a company owner', async () => {
    h.user = null;
    expect((await GET()).status).toBe(401);
    h.user = { id: PLAIN_OWNER };
    const res = await GET();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('rest_of_latam');
  });

  it('lists the mapped countries in order', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).markets).toEqual([
      { countryCode: 'DO', market: 'rest_of_latam' },
      { countryCode: 'MX', market: 'mexico' },
    ]);
  });
});

describe('PUT', () => {
  it('401s and 403s without writing', async () => {
    const body = { entries: [{ country_code: 'DO', market: 'mexico' }] };
    h.user = null;
    expect((await put(body)).status).toBe(401);
    h.user = { id: PLAIN_OWNER };
    expect((await put(body)).status).toBe(403);
    expect(
      h.db.rows('meta_market_countries').find((r) => r.country_code === 'DO')
        ?.market
    ).toBe('rest_of_latam');
  });

  it('upserts, adds and removes countries, and answers the whole table', async () => {
    const res = await put({
      entries: [
        { country_code: 'gt', market: 'rest_of_latam' },
        { country_code: 'MX', market: 'mexico_new' },
        { country_code: 'DO', market: null },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).markets).toEqual([
      { countryCode: 'GT', market: 'rest_of_latam' },
      { countryCode: 'MX', market: 'mexico_new' },
    ]);
  });

  it.each([
    ['no entries', {}],
    ['a bad code', { entries: [{ country_code: 'DOM', market: 'x_y' }] }],
    [
      'a bad market',
      { entries: [{ country_code: 'DO', market: 'Resto LatAm' }] },
    ],
  ])('400s %s', async (_label, body) => {
    expect((await put(body)).status).toBe(400);
    expect(h.db.rows('meta_market_countries')).toHaveLength(2);
  });

  it('400s a body that is not JSON', async () => {
    expect((await put('{nope')).status).toBe(400);
  });
});
