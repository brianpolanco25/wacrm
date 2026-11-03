import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH /api/platform/integrations/[id]/operations/[opId] (n13.1, R7, R10).

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
const { __resetRateLimitForTests } = await import('@/lib/rate-limit');
const support = await import('@/lib/integrations/integrations.test-support');
const route = await import('./route');
const { PATCH } = route;
const { OPERATOR, PLAIN_OWNER, HEALTH_ID, DRAFT_ID, OP_CREATE_ID, OP_LIST_ID } =
  support;

function patch(id: string, opId: string, body: unknown) {
  return PATCH(
    new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, opId }) }
  );
}

const op = (id: string) =>
  h.db.rows('integration_operations').find((r) => r.id === id)!;

beforeEach(() => {
  __resetRateLimitForTests();
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(support.seedIntegrationTables());
});

describe('PATCH /api/platform/integrations/[id]/operations/[opId]', () => {
  it('200 edits and retires an operation (R10)', async () => {
    const res = await patch(HEALTH_ID, OP_LIST_ID, {
      name: 'Doctores',
      is_active: false,
    });
    expect(res.status).toBe(200);
    expect(op(OP_LIST_ID)).toMatchObject({
      name: 'Doctores',
      is_active: false,
    });
  });

  it('400 when switching to GET with stored body params', async () => {
    const res = await patch(HEALTH_ID, OP_CREATE_ID, { method: 'GET' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'params' });
    expect(op(OP_CREATE_ID).method).toBe('POST');
  });

  it('404 when the operation belongs to another integration', async () => {
    expect((await patch(DRAFT_ID, OP_LIST_ID, { name: 'x' })).status).toBe(404);
    expect(op(OP_LIST_ID).name).toBe('Listar doctores');
  });

  it('401 / 403 without writing', async () => {
    h.user = null;
    expect((await patch(HEALTH_ID, OP_LIST_ID, { name: 'x' })).status).toBe(
      401
    );
    h.user = { id: PLAIN_OWNER };
    expect((await patch(HEALTH_ID, OP_LIST_ID, { name: 'x' })).status).toBe(
      403
    );
    expect(op(OP_LIST_ID).name).toBe('Listar doctores');
  });

  it('exports no DELETE (R10)', () => {
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
