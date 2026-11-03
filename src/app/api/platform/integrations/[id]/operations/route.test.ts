import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/integrations/[id]/operations (n13.1, R4, R7–R9).

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  duplicateInsert: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) =>
      h.duplicateInsert && table === 'integration_operations'
        ? Object.assign(h.db.admin.from(table), {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { code: '23505', message: 'duplicate key' },
                }),
              }),
            }),
          })
        : h.db.admin.from(table),
  }),
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { __resetRateLimitForTests } = await import('@/lib/rate-limit');
const support = await import('@/lib/integrations/integrations.test-support');
const route = await import('./route');
const { POST } = route;
const { OPERATOR, PLAIN_OWNER, HEALTH_ID } = support;

const OP = {
  key: 'get_doctor',
  name: 'Ver doctor',
  description: 'Devuelve un doctor por id',
  method: 'GET',
  path: '/doctors/{id}',
  params: [
    {
      name: 'id',
      in: 'path',
      type: 'integer',
      required: true,
      description: 'Id',
    },
  ],
};

function post(id: string, body: unknown) {
  return POST(
    new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(support.seedIntegrationTables());
  h.duplicateInsert = false;
});

describe('POST /api/platform/integrations/[id]/operations', () => {
  it('201 creates the operation under that integration', async () => {
    const res = await post(HEALTH_ID, OP);
    expect(res.status).toBe(201);
    const { operation } = await res.json();
    expect(operation).toMatchObject({
      key: 'get_doctor',
      integration_id: HEALTH_ID,
    });
    expect(h.db.rows('integration_operations')).toHaveLength(4);
  });

  it('400 with the field when placeholders and params disagree', async () => {
    const res = await post(HEALTH_ID, { ...OP, params: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'path' });
  });

  it('409 on a duplicate key', async () => {
    h.duplicateInsert = true;
    const res = await post(HEALTH_ID, { ...OP, key: 'list_doctors' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ field: 'key' });
  });

  it('404 for an unknown integration', async () => {
    expect(
      (await post('9a000000-0000-4000-8000-0000000000ff', OP)).status
    ).toBe(404);
  });

  it('401 / 403 without writing', async () => {
    h.user = null;
    expect((await post(HEALTH_ID, OP)).status).toBe(401);
    h.user = { id: PLAIN_OWNER };
    expect((await post(HEALTH_ID, OP)).status).toBe(403);
    expect(h.db.rows('integration_operations')).toHaveLength(3);
  });
});
