import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET/POST /api/platform/integrations (n13.1, R4, R5, R11). La base es
// el FakeDatabase en memoria; `isDeliverableUrl` se simula (sin DNS).

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  duplicateInsert: false,
  deliverable: true,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) =>
      h.duplicateInsert && table === 'integrations'
        ? {
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

vi.mock('@/lib/webhooks/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/ssrf')>()),
  isDeliverableUrl: async () => h.deliverable,
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { __resetRateLimitForTests } = await import('@/lib/rate-limit');
const support = await import('@/lib/integrations/integrations.test-support');
const route = await import('./route');
const { GET, POST } = route;
const { OPERATOR, PLAIN_OWNER, HEALTH_ID, DRAFT_ID, RETIRED_ID } = support;

const NEW = {
  slug: 'agenda',
  name: 'Agenda',
  base_url: 'https://agenda.example.com/api/',
  auth_scheme: 'header',
  auth_header_name: 'X-Api-Key',
  test_path: '/ping',
};

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/platform/integrations', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(support.seedIntegrationTables());
  h.duplicateInsert = false;
  h.deliverable = true;
});

describe('GET /api/platform/integrations', () => {
  it('401 without a session', async () => {
    h.user = null;
    expect((await GET()).status).toBe(401);
  });

  it('403 for a company owner who is not an operator', async () => {
    h.user = { id: PLAIN_OWNER };
    const res = await GET();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('health');
  });

  it('lists every integration with active operations and enabled accounts (R11)', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const { integrations } = await res.json();
    expect(
      integrations.map(
        (i: {
          id: string;
          is_active: boolean;
          operationsActive: number;
          accountsEnabled: number;
        }) => [i.id, i.is_active, i.operationsActive, i.accountsEnabled]
      )
    ).toEqual([
      [HEALTH_ID, true, 2, 1],
      [DRAFT_ID, false, 0, 0],
      [RETIRED_ID, false, 0, 1],
    ]);
    // Ninguna credencial de cuenta viaja en el listado.
    expect(JSON.stringify(integrations)).not.toContain('enc-b');
  });
});

describe('POST /api/platform/integrations', () => {
  it('401 / 403 without writing', async () => {
    h.user = null;
    expect((await post(NEW)).status).toBe(401);
    h.user = { id: PLAIN_OWNER };
    expect((await post(NEW)).status).toBe(403);
    expect(h.db.rows('integrations')).toHaveLength(3);
  });

  it('201 creates a draft with the normalized base url and the author (R5)', async () => {
    const res = await post(NEW);
    expect(res.status).toBe(201);
    const { integration } = await res.json();
    expect(integration).toMatchObject({
      slug: 'agenda',
      base_url: 'https://agenda.example.com/api',
      auth_header_name: 'X-Api-Key',
      is_active: false,
    });
    const row = h.db.rows('integrations').find((r) => r.slug === 'agenda')!;
    expect(row.created_by).toBe(OPERATOR);
    expect(row.updated_by).toBe(OPERATOR);
  });

  it('400 with the field on a validation error', async () => {
    const res = await post({ ...NEW, base_url: 'https://10.0.0.1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'base_url' });
    expect(h.db.rows('integrations')).toHaveLength(3);
  });

  it('400 when the host does not resolve to a public address', async () => {
    h.deliverable = false;
    const res = await post(NEW);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'base_url' });
    expect(h.db.rows('integrations')).toHaveLength(3);
  });

  it('409 on a duplicate slug', async () => {
    h.duplicateInsert = true;
    const res = await post({ ...NEW, slug: 'health' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ field: 'slug' });
  });

  it('exports no DELETE (R10)', () => {
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
