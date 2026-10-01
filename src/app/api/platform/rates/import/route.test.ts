import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/rates/import (s10.2): preview first, then an
// all-or-nothing insert. The database is the in-memory fake.

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
const { POST } = await import('./route');

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/platform/rates/import', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

const CSV = [
  'market,category,usd_per_message,effective_from',
  'rest_of_latam,marketing,0.0740,2026-10-01',
  'mexico,marketing,0.0436,2026-10-01',
  'mexico,utility,0.0085,2026-10-01',
].join('\n');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(seedRateTables());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/platform/rates/import', () => {
  it('401s and 403s without writing', async () => {
    h.user = null;
    expect((await post({ csv: CSV })).status).toBe(401);
    h.user = { id: PLAIN_OWNER };
    const res = await post({ csv: CSV });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('mexico');
    expect(h.db.rows('meta_rates')).toHaveLength(3);
  });

  it('previews without writing anything (dryRun)', async () => {
    const res = await post({ csv: CSV, dryRun: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBe(0);
    expect(body.preview.rows.map((r: { status: string }) => r.status)).toEqual([
      'exists',
      'new',
      'new',
    ]);
    expect(body.preview.importable).toBe(true);
    expect(h.db.rows('meta_rates')).toHaveLength(3);
  });

  it('imports the new rows only, in one insert, and skips the ones already there', async () => {
    const res = await post({ csv: CSV });
    expect(res.status).toBe(201);
    expect((await res.json()).inserted).toBe(2);
    const rows = h.db.rows('meta_rates');
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.market === 'mexico')).toEqual([
      expect.objectContaining({
        category: 'marketing',
        usd_per_message: 0.0436,
        created_by: OPERATOR,
      }),
      expect.objectContaining({
        category: 'utility',
        usd_per_message: 0.0085,
        created_by: OPERATOR,
      }),
    ]);
    expect(
      h.db.log.filter((e) => e.table === 'meta_rates' && e.op === 'insert')
    ).toHaveLength(1);
    // Importing the same text again is a no-op, not an edit.
    const again = await post({ csv: CSV });
    expect(again.status).toBe(201);
    expect((await again.json()).inserted).toBe(0);
    expect(h.db.rows('meta_rates')).toHaveLength(5);
  });

  it('400s and writes nothing when a line would edit a rate in force', async () => {
    const res = await post({
      csv: CSV + '\nrest_of_latam,utility,0.0200,2026-10-01',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.preview.importable).toBe(false);
    expect(body.preview.rows.at(-1)).toMatchObject({
      line: 5,
      status: 'conflict',
    });
    expect(h.db.rows('meta_rates')).toHaveLength(3);
  });

  it.each([
    ['no csv', {}],
    ['a csv that is not text', { csv: 42 }],
    ['a dryRun that is not boolean', { csv: CSV, dryRun: 'yes' }],
    ['an empty csv', { csv: '\n' }],
    ['a csv above the size cap', { csv: 'x'.repeat(200_001) }],
  ])('400s %s', async (_label, body) => {
    expect((await post(body)).status).toBe(400);
    expect(h.db.rows('meta_rates')).toHaveLength(3);
  });

  it('400s a body that is not JSON', async () => {
    expect((await post('{nope')).status).toBe(400);
  });
});
