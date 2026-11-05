import { beforeEach, describe, expect, it, vi } from 'vitest';

// PUT / DELETE /api/account/integrations/{integrationId} (n13.1, R13,
// R15–R17, R32).

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

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const support = await import('@/lib/integrations/integrations.test-support');
const { decrypt } = await import('@/lib/whatsapp/encryption');
const { __resetRateLimitForTests } = await import('@/lib/rate-limit');
const { PUT, DELETE, PATCH } = await import('./route');
const { ACCOUNT_A, HEALTH_ID, DRAFT_ID, USER_A, accountCtx } = support;

const params = (integrationId: string) => ({
  params: Promise.resolve({ integrationId }),
});

function put(id: string, body: unknown) {
  return PUT(
    new Request('http://localhost', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id)
  );
}
function patch(id: string, body: unknown, raw?: string) {
  return PATCH(
    new Request('http://localhost', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }),
    params(id)
  );
}
const del = (id: string) =>
  DELETE(new Request('http://localhost', { method: 'DELETE' }), params(id));

const rowsA = () =>
  h.db.rows('account_integrations').filter((r) => r.account_id === ACCOUNT_A);

beforeEach(() => {
  __resetRateLimitForTests();
  h.db = new FakeDatabase(support.seedIntegrationTables());
  h.ctx = accountCtx('admin');
  h.features = ['integrations'];
});

describe('PUT — activate / change the credential (R15)', () => {
  const CRED = 'sanctum-token-ABCDEFGH-1234';

  it('stores encrypt(credential), last4 and the author; answers without the credential', async () => {
    const res = await put(HEALTH_ID, { credential: CRED });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.integration).toMatchObject({
      id: HEALTH_ID,
      enabled: true,
      credentialLast4: '1234',
      lastTestStatus: null,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(CRED);
    expect(raw).not.toContain('"credential"');

    expect(rowsA()).toHaveLength(1);
    const row = rowsA()[0];
    expect(row.credential).not.toBe(CRED);
    expect(decrypt(row.credential as string)).toBe(CRED);
    expect(row).toMatchObject({
      is_enabled: true,
      credential_last4: '1234',
      enabled_by: USER_A,
      last_tested_at: null,
      last_test_status: null,
    });
    expect(raw).not.toContain(row.credential as string);
  });

  it('a second call replaces the credential without a second row and clears the test', async () => {
    await put(HEALTH_ID, { credential: CRED });
    rowsA()[0].last_test_status = 'ok';
    await put(HEALTH_ID, { credential: 'second-credential-XYZW' });
    expect(rowsA()).toHaveLength(1);
    expect(decrypt(rowsA()[0].credential as string)).toBe(
      'second-credential-XYZW'
    );
    expect(rowsA()[0].last_test_status).toBeNull();
  });

  it('a short credential is stored without last4', async () => {
    await put(HEALTH_ID, { credential: 'abc123' });
    expect(rowsA()[0].credential_last4).toBeNull();
  });

  it.each([
    ['line breaks', 'abc\r\ndef'],
    ['a control character', 'abc\u0000def'],
    ['too long', 'x'.repeat(4097)],
    ['empty', ''],
    ['surrounding spaces', ' abc '],
    ['not a string', 123],
    ['typographic quotes pasted from a document', '“sanctum-token-1234”'],
    ['a non-ASCII letter', 'contraseña-1234567'],
    ['a non-breaking space', 'abc\u00a0def'],
  ])('400 for %s', async (_label, credential) => {
    const res = await put(HEALTH_ID, { credential });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'credential' });
    expect(rowsA()).toHaveLength(0);
  });

  it('accepts exactly 4096 characters', async () => {
    expect(
      (await put(HEALTH_ID, { credential: 'x'.repeat(4096) })).status
    ).toBe(200);
  });

  it('404 for an inactive or unknown integration', async () => {
    expect((await put(DRAFT_ID, { credential: CRED })).status).toBe(404);
    expect(
      (await put('9a000000-0000-4000-8000-0000000000ff', { credential: CRED }))
        .status
    ).toBe(404);
    expect((await put('not-a-uuid', { credential: CRED })).status).toBe(404);
    expect(rowsA()).toHaveLength(0);
  });

  it('402 without the integrations feature (R13)', async () => {
    h.features = ['api'];
    const res = await put(HEALTH_ID, { credential: CRED });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ upgradeUrl: expect.any(String) });
    expect(rowsA()).toHaveLength(0);
  });

  it.each(['agent', 'viewer'] as const)('403 for %s (R16)', async (role) => {
    h.ctx = accountCtx(role);
    expect((await put(HEALTH_ID, { credential: CRED })).status).toBe(403);
    expect(rowsA()).toHaveLength(0);
  });

  it('403 inside a support session (D3, R32)', async () => {
    h.ctx = accountCtx('admin', { impersonated: true });
    expect((await put(HEALTH_ID, { credential: CRED })).status).toBe(403);
    expect(rowsA()).toHaveLength(0);
  });
});

describe('PUT keeps the AI settings (n13.3)', () => {
  it('changing the credential does not touch ai_*', async () => {
    await put(HEALTH_ID, { credential: 'sanctum-token-ABCDEFGH-1234' });
    Object.assign(rowsA()[0], {
      ai_enabled: true,
      ai_instructions: 'Citas de 30 min.',
      ai_timezone: 'America/Santo_Domingo',
    });
    await put(HEALTH_ID, { credential: 'second-credential-XYZW' });
    expect(rowsA()[0]).toMatchObject({
      ai_enabled: true,
      ai_instructions: 'Citas de 30 min.',
      ai_timezone: 'America/Santo_Domingo',
    });
  });
});

describe('PATCH — AI settings (n13.3, R32)', () => {
  beforeEach(async () => {
    await put(HEALTH_ID, { credential: 'sanctum-token-ABCDEFGH-1234' });
  });

  it('stores the three fields and answers the updated view', async () => {
    const res = await patch(HEALTH_ID, {
      aiEnabled: true,
      aiInstructions: '  Citas de 30 min.  ',
      aiTimezone: 'America/Santo_Domingo',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).integration).toMatchObject({
      id: HEALTH_ID,
      aiEnabled: true,
      aiInstructions: 'Citas de 30 min.',
      aiTimezone: 'America/Santo_Domingo',
    });
    expect(rowsA()[0]).toMatchObject({
      ai_enabled: true,
      ai_instructions: 'Citas de 30 min.',
      ai_timezone: 'America/Santo_Domingo',
    });
  });

  it('a partial patch leaves the other fields alone; empty text and null clear', async () => {
    await patch(HEALTH_ID, {
      aiEnabled: true,
      aiInstructions: 'x',
      aiTimezone: 'UTC',
    });
    await patch(HEALTH_ID, { aiInstructions: '   ' });
    expect(rowsA()[0]).toMatchObject({
      ai_enabled: true,
      ai_instructions: null,
      ai_timezone: 'UTC',
    });
    await patch(HEALTH_ID, { aiTimezone: null, aiEnabled: false });
    expect(rowsA()[0]).toMatchObject({ ai_enabled: false, ai_timezone: null });
  });

  it.each([
    ['aiEnabled', { aiEnabled: 'yes' }],
    ['aiInstructions', { aiInstructions: 'x'.repeat(2001) }],
    ['aiInstructions', { aiInstructions: 42 }],
    ['aiTimezone', { aiTimezone: 'Mars/Base' }],
    ['aiTimezone', { aiTimezone: 7 }],
    ['body', {}],
    ['body', { other: true }],
  ])('400 with field %s', async (field, body) => {
    const before = { ...rowsA()[0] };
    const res = await patch(HEALTH_ID, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field });
    expect(rowsA()[0]).toEqual(before);
  });

  it('400 for an empty body', async () => {
    const res = await patch(HEALTH_ID, null, '');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'body' });
  });

  it('accepts exactly 2000 characters', async () => {
    expect(
      (await patch(HEALTH_ID, { aiInstructions: 'x'.repeat(2000) })).status
    ).toBe(200);
  });

  it('402 without the integrations feature', async () => {
    h.features = ['api'];
    expect((await patch(HEALTH_ID, { aiEnabled: true })).status).toBe(402);
    expect(rowsA()[0].ai_enabled).toBeUndefined();
  });

  it('404 when this account has not activated it (or deactivated it)', async () => {
    expect((await patch(DRAFT_ID, { aiEnabled: true })).status).toBe(404);
    expect((await patch('not-a-uuid', { aiEnabled: true })).status).toBe(404);
    await del(HEALTH_ID);
    expect((await patch(HEALTH_ID, { aiEnabled: true })).status).toBe(404);
    expect(rowsA()[0].ai_enabled).toBeUndefined();
  });

  it('404 on an integration only another account activated; its row is untouched', async () => {
    const rowB = h.db
      .rows('account_integrations')
      .find((r) => r.id === 'ai-b-retired')!;
    const before = { ...rowB };
    const { RETIRED_ID } = support;
    expect((await patch(RETIRED_ID, { aiEnabled: true })).status).toBe(404);
    expect(rowB).toEqual(before);
  });

  it.each(['agent', 'viewer'] as const)('403 for %s', async (role) => {
    h.ctx = accountCtx(role);
    expect((await patch(HEALTH_ID, { aiEnabled: true })).status).toBe(403);
    expect(rowsA()[0].ai_enabled).toBeUndefined();
  });

  it('403 inside a support session', async () => {
    h.ctx = accountCtx('admin', { impersonated: true });
    expect((await patch(HEALTH_ID, { aiEnabled: true })).status).toBe(403);
    expect(rowsA()[0].ai_enabled).toBeUndefined();
  });
});

describe('DELETE — deactivate (R17, D5)', () => {
  beforeEach(async () => {
    await put(HEALTH_ID, { credential: 'sanctum-token-ABCDEFGH-1234' });
  });

  it('clears the credential and keeps the row; repeating answers 200 the same', async () => {
    const first = await del(HEALTH_ID);
    expect(first.status).toBe(200);
    expect(rowsA()).toHaveLength(1);
    expect(rowsA()[0]).toMatchObject({
      is_enabled: false,
      credential: null,
      credential_last4: null,
    });
    const second = await del(HEALTH_ID);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });

  it('is allowed without the plan feature', async () => {
    h.features = [];
    expect((await del(HEALTH_ID)).status).toBe(200);
  });

  it('404 without a row for this account', async () => {
    expect((await del(DRAFT_ID)).status).toBe(404);
  });

  it.each(['agent', 'viewer'] as const)('403 for %s (R16)', async (role) => {
    h.ctx = accountCtx(role);
    expect((await del(HEALTH_ID)).status).toBe(403);
    expect(rowsA()[0].is_enabled).toBe(true);
  });

  it('403 inside a support session', async () => {
    h.ctx = accountCtx('admin', { impersonated: true });
    expect((await del(HEALTH_ID)).status).toBe(403);
    expect(rowsA()[0].is_enabled).toBe(true);
  });
});
