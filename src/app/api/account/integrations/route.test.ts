import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/account/integrations (n13.1, R13, R14).

const h = vi.hoisted(() => ({
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  ctx: null as unknown,
  features: ['integrations'] as string[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: async () => h.ctx,
}));
vi.mock('@/lib/auth/admin-client', () => ({ supabaseAdmin: () => h.db.admin }));
vi.mock('@/lib/billing/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/entitlements')>()),
  getEntitlements: async () => support.entitlementsWith(h.features),
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const support = await import('@/lib/integrations/integrations.test-support');
const { encrypt } = await import('@/lib/whatsapp/encryption');
const { GET } = await import('./route');
const { ACCOUNT_A, ACCOUNT_B, HEALTH_ID, RETIRED_ID, accountCtx } = support;

const CRED_A = 'plaintext-credential-of-A-0042';
let cipherA: string;

beforeEach(() => {
  const seed = support.seedIntegrationTables();
  cipherA = encrypt(CRED_A);
  seed.account_integrations.push({
    id: 'ai-a-health',
    account_id: ACCOUNT_A,
    integration_id: HEALTH_ID,
    is_enabled: true,
    credential: cipherA,
    credential_last4: '0042',
    enabled_by: null,
    enabled_at: '2026-11-02T10:00:00.000Z',
    last_tested_at: '2026-11-02T10:00:05.000Z',
    last_test_status: 'ok',
  });
  h.db = new FakeDatabase(seed);
  h.ctx = accountCtx('agent');
  h.features = ['integrations'];
});

describe('GET /api/account/integrations', () => {
  it('returns the exact shape, with this account state and no credential', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      planAllows: true,
      canManage: false,
      integrations: [
        {
          id: HEALTH_ID,
          slug: 'health',
          name: 'Cabbity Health',
          description: 'Citas y doctores',
          logoUrl: null,
          authScheme: 'bearer',
          authHeaderName: null,
          credentialHelp: null,
          retired: false,
          operations: [
            {
              key: 'list_doctors',
              name: 'Listar doctores',
              description: 'Devuelve los doctores de la clínica',
              method: 'GET',
            },
            {
              key: 'create_appointment',
              name: 'Crear cita',
              description: 'Crea una cita',
              method: 'POST',
            },
          ],
          enabled: true,
          credentialLast4: '0042',
          enabledAt: '2026-11-02T10:00:00.000Z',
          lastTestedAt: '2026-11-02T10:00:05.000Z',
          lastTestStatus: 'ok',
        },
      ],
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(cipherA);
    expect(raw).not.toContain(CRED_A);
    expect(raw).not.toContain('"credential"');
  });

  it('a draft or retired integration without activation does not appear', async () => {
    const body = await (await GET()).json();
    expect(body.integrations.map((i: { slug: string }) => i.slug)).toEqual([
      'health',
    ]);
  });

  it('a retired integration the account still has enabled comes back as retired', async () => {
    h.ctx = accountCtx('owner', { accountId: ACCOUNT_B });
    const body = await (await GET()).json();
    expect(
      body.integrations.map(
        (i: { id: string; retired: boolean; enabled: boolean }) => [
          i.id,
          i.retired,
          i.enabled,
        ]
      )
    ).toEqual([
      [HEALTH_ID, false, true],
      [RETIRED_ID, true, true],
    ]);
    expect(body.integrations[0].credentialLast4).toBe('bbbb');
  });

  it('planAllows false without the feature (R13); canManage for admin', async () => {
    h.features = ['api'];
    h.ctx = accountCtx('admin');
    const body = await (await GET()).json();
    expect(body.planAllows).toBe(false);
    expect(body.canManage).toBe(true);
  });

  it('canManage is false inside a support session (D3)', async () => {
    h.ctx = accountCtx('admin', { impersonated: true });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).canManage).toBe(false);
  });

  it('an account that never enabled anything sees the catalogue as not enabled', async () => {
    h.ctx = accountCtx('viewer', {
      accountId: 'cccccccc-0000-4000-8000-00000000000c',
    });
    const body = await (await GET()).json();
    expect(body.integrations).toHaveLength(1);
    expect(body.integrations[0]).toMatchObject({
      enabled: false,
      credentialLast4: null,
      lastTestStatus: null,
    });
  });
});
