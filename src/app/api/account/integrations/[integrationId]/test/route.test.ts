import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/account/integrations/{integrationId}/test (n13.1, R13, R16,
// R18, R32). La red es un `fetch` global simulado; el DNS, simulado.

const h = vi.hoisted(() => ({
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  ctx: null as unknown as { role: string; impersonation: unknown },
  features: ['integrations'] as string[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireRole: async (min: 'admin') => {
      if (!hasMinRole(h.ctx.role as 'admin', min)) {
        throw new actual.ForbiddenError(
          `This action requires the '${min}' role or higher`
        );
      }
      return h.ctx;
    },
  };
});
vi.mock('@/lib/auth/support-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/support-actions')>()),
  markSupportActionStatus: async () => {},
}));
vi.mock('@/lib/auth/admin-client', () => ({ supabaseAdmin: () => h.db.admin }));
vi.mock('@/lib/billing/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/entitlements')>()),
  getEntitlements: async () => support.entitlementsWith(h.features),
}));
vi.mock('@/lib/webhooks/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/ssrf')>()),
  isDeliverableUrl: async () => true,
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const support = await import('@/lib/integrations/integrations.test-support');
const { encrypt } = await import('@/lib/whatsapp/encryption');
const { __resetRateLimitForTests } = await import('@/lib/rate-limit');
const { POST } = await import('./route');
const { ACCOUNT_A, HEALTH_ID, DRAFT_ID, accountCtx } = support;

const CRED_A = 'credential-of-account-A-7777';
let fetchSpy: ReturnType<typeof vi.fn>;

const test = (id = HEALTH_ID) =>
  POST(new Request('http://localhost', { method: 'POST' }), {
    params: Promise.resolve({ integrationId: id }),
  });

beforeEach(() => {
  __resetRateLimitForTests();
  const seed = support.seedIntegrationTables();
  seed.account_integrations.push({
    id: 'ai-a-health',
    account_id: ACCOUNT_A,
    integration_id: HEALTH_ID,
    is_enabled: true,
    credential: encrypt(CRED_A),
    credential_last4: '7777',
    enabled_by: null,
    enabled_at: '2026-11-02T10:00:00.000Z',
    last_tested_at: null,
    last_test_status: null,
  });
  h.db = new FakeDatabase(seed);
  h.ctx = accountCtx('admin');
  h.features = ['integrations'];
  fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ user: 'PATIENT-DATA' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/account/integrations/{id}/test', () => {
  it('200 with result and status only; stores the result and logs a test call', async () => {
    const res = await test();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      result: 'ok',
      status: 200,
      testedAt: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain('PATIENT-DATA');

    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe(
      `Bearer ${CRED_A}`
    );
    const row = h.db
      .rows('account_integrations')
      .find((r) => r.account_id === ACCOUNT_A)!;
    expect(row.last_test_status).toBe('ok');
    const call = h.db
      .rows('integration_calls')
      .find((r) => r.account_id === ACCOUNT_A)!;
    expect(call).toMatchObject({
      source: 'test',
      operation_key: null,
      outcome: 'ok',
    });
  });

  it('401 from the remote → auth_failed', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 401 }));
    expect(await (await test()).json()).toMatchObject({
      result: 'auth_failed',
      status: 401,
    });
  });

  it('404 without an activation', async () => {
    expect((await test(DRAFT_ID)).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('429 when the account bucket is spent', async () => {
    for (let i = 0; i < 60; i++) await test();
    const res = await test();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('402 without the plan feature (R13)', async () => {
    h.features = [];
    expect((await test()).status).toBe(402);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['agent', 'viewer'] as const)('403 for %s', async (role) => {
    h.ctx = accountCtx(role);
    expect((await test()).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('403 inside a support session', async () => {
    h.ctx = accountCtx('admin', { impersonated: true });
    expect((await test()).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
