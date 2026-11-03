import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET/PATCH /api/platform/integrations/[id] (n13.1, R4, R6, R10).

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  deliverable: true,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

vi.mock('@/lib/webhooks/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/ssrf')>()),
  isDeliverableUrl: async () => h.deliverable,
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { __resetRateLimitForTests } = await import('@/lib/rate-limit');
const support = await import('@/lib/integrations/integrations.test-support');
const route = await import('./route');
const { GET, PATCH } = route;
const { OPERATOR, PLAIN_OWNER, HEALTH_ID, DRAFT_ID } = support;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const MISSING = '9a000000-0000-4000-8000-0000000000ff';

function patch(id: string, body: unknown) {
  return PATCH(
    new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    ctx(id)
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(support.seedIntegrationTables());
  h.deliverable = true;
});

describe('GET /api/platform/integrations/[id]', () => {
  it('returns the integration with every operation, active or not', async () => {
    const res = await GET(new Request('http://localhost'), ctx(HEALTH_ID));
    expect(res.status).toBe(200);
    const { integration } = await res.json();
    expect(integration.slug).toBe('health');
    expect(integration.operations.map((o: { key: string }) => o.key)).toEqual([
      'list_doctors',
      'create_appointment',
      'old_op',
    ]);
  });

  it('404 for a missing or malformed id; 403 for a non-operator', async () => {
    expect(
      (await GET(new Request('http://localhost'), ctx(MISSING))).status
    ).toBe(404);
    expect(
      (await GET(new Request('http://localhost'), ctx('nope'))).status
    ).toBe(404);
    h.user = { id: PLAIN_OWNER };
    expect(
      (await GET(new Request('http://localhost'), ctx(HEALTH_ID))).status
    ).toBe(403);
  });
});

describe('PATCH /api/platform/integrations/[id]', () => {
  it('applies a partial edit and stamps updated_by (R6)', async () => {
    const res = await patch(HEALTH_ID, { name: 'Health', is_active: false });
    expect(res.status).toBe(200);
    const row = h.db.rows('integrations').find((r) => r.id === HEALTH_ID)!;
    expect(row).toMatchObject({
      name: 'Health',
      is_active: false,
      slug: 'health',
    });
    expect(row.updated_by).toBe(OPERATOR);
  });

  it('retiring leaves the account activations untouched (R10)', async () => {
    const before = JSON.stringify(h.db.rows('account_integrations'));
    await patch(HEALTH_ID, { is_active: false });
    expect(JSON.stringify(h.db.rows('account_integrations'))).toBe(before);
  });

  it('400 when trying to change the slug', async () => {
    const res = await patch(HEALTH_ID, { slug: 'other' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'slug' });
    expect(
      h.db.rows('integrations').find((r) => r.id === HEALTH_ID)!.slug
    ).toBe('health');
  });

  it('400 when switching to header auth with no stored header name', async () => {
    const res = await patch(HEALTH_ID, { auth_scheme: 'header' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'auth_header_name' });
  });

  it('400 when the new base url is not deliverable', async () => {
    h.deliverable = false;
    const res = await patch(HEALTH_ID, {
      base_url: 'https://elsewhere.example.com',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'base_url' });
  });

  describe('changing where the credential goes (review finding 4)', () => {
    const health = () =>
      h.db.rows('integrations').find((r) => r.id === HEALTH_ID)!;
    const activations = () =>
      h.db
        .rows('account_integrations')
        .filter((r) => r.integration_id === HEALTH_ID);

    it('409 integration_in_use when the origin changes and accounts have it enabled', async () => {
      const before = JSON.stringify(h.db.rows('account_integrations'));
      const res = await patch(HEALTH_ID, {
        base_url: 'https://other.example.com/api/v1',
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'integration_in_use',
        field: 'base_url',
        accountsEnabled: 1,
      });
      expect(health().base_url).toBe('https://health.example.com/api/v1');
      expect(JSON.stringify(h.db.rows('account_integrations'))).toBe(before);
    });

    it('409 too for a new auth scheme or a new header name', async () => {
      const scheme = await patch(HEALTH_ID, {
        auth_scheme: 'header',
        auth_header_name: 'X-Api-Key',
      });
      expect(scheme.status).toBe(409);
      expect(await scheme.json()).toMatchObject({ field: 'auth_scheme' });
      health().auth_scheme = 'header';
      health().auth_header_name = 'X-Api-Key';
      const header = await patch(HEALTH_ID, { auth_header_name: 'X-Other' });
      expect(header.status).toBe(409);
      expect(await header.json()).toMatchObject({ field: 'auth_header_name' });
      // Same header in another case: same destination, no confirmation.
      expect(
        (await patch(HEALTH_ID, { auth_header_name: 'x-api-key' })).status
      ).toBe(200);
    });

    it('a new path prefix on the same origin needs no confirmation', async () => {
      const res = await patch(HEALTH_ID, {
        base_url: 'https://health.example.com/api/v2',
      });
      expect(res.status).toBe(200);
      expect(activations()[0]).toMatchObject({
        is_enabled: true,
        credential: 'enc-b',
      });
    });

    it('reset_activations: true deactivates every account (credential gone) and saves', async () => {
      const res = await patch(HEALTH_ID, {
        base_url: 'https://other.example.com/api/v1',
        reset_activations: true,
      });
      expect(res.status).toBe(200);
      expect(health().base_url).toBe('https://other.example.com/api/v1');
      for (const row of activations()) {
        expect(row).toMatchObject({
          is_enabled: false,
          credential: null,
          credential_last4: null,
          last_test_status: null,
        });
      }
      // Another integration's activation is untouched.
      expect(
        h.db.rows('account_integrations').find((r) => r.id === 'ai-b-retired')
      ).toMatchObject({ is_enabled: true, credential: 'enc-b2' });
    });

    it('an integration nobody enabled changes origin freely', async () => {
      expect(
        (await patch(DRAFT_ID, { base_url: 'https://new.example.com' })).status
      ).toBe(200);
    });
  });

  it('404 for a missing integration', async () => {
    expect((await patch(MISSING, { name: 'x' })).status).toBe(404);
  });

  it('401 / 403 without writing', async () => {
    h.user = null;
    expect((await patch(HEALTH_ID, { name: 'x' })).status).toBe(401);
    h.user = { id: PLAIN_OWNER };
    expect((await patch(HEALTH_ID, { name: 'x' })).status).toBe(403);
    expect(
      h.db.rows('integrations').find((r) => r.id === HEALTH_ID)!.name
    ).toBe('Cabbity Health');
  });

  it('exports no DELETE (R10)', () => {
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
