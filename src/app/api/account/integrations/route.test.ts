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
  it('carries the AI settings of this account (n13.3, R33)', async () => {
    Object.assign(
      h.db.rows('account_integrations').find((r) => r.id === 'ai-a-health')!,
      {
        ai_enabled: true,
        ai_instructions: 'Citas de 30 min.',
        ai_timezone: 'America/Santo_Domingo',
      }
    );
    // B's row for the same integration carries other values.
    Object.assign(
      h.db.rows('account_integrations').find((r) => r.id === 'ai-b-health')!,
      { ai_enabled: false, ai_instructions: 'B only', ai_timezone: 'UTC' }
    );
    const body = await (await GET()).json();
    expect(body.integrations[0]).toMatchObject({
      aiEnabled: true,
      aiInstructions: 'Citas de 30 min.',
      aiTimezone: 'America/Santo_Domingo',
    });
    expect(JSON.stringify(body)).not.toContain('B only');
  });

  it('a deactivated integration reports false/null even with stored AI values (R33)', async () => {
    Object.assign(
      h.db.rows('account_integrations').find((r) => r.id === 'ai-a-health')!,
      {
        is_enabled: false,
        credential: null,
        ai_enabled: true,
        ai_instructions: 'kept',
        ai_timezone: 'UTC',
      }
    );
    const body = await (await GET()).json();
    expect(body.integrations[0]).toMatchObject({
      enabled: false,
      aiEnabled: false,
      aiInstructions: null,
      aiTimezone: null,
    });
  });

  it('returns the exact shape, with this account state and no credential', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      planAllows: true,
      canManage: false,
      supportSession: false,
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
          // n13.3 (R33): defaults of migration 094.
          aiEnabled: false,
          aiInstructions: null,
          aiTimezone: null,
          // n13.7 (R6): default of migration 095 and the active GET
          // operations with their caller parameters.
          aiLiveReads: [],
          aiReadOperations: [
            {
              key: 'list_doctors',
              name: 'Listar doctores',
              params: [
                {
                  name: 'specialty',
                  type: 'string',
                  required: false,
                  description: 'Especialidad',
                },
              ],
            },
          ],
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

  it('n13.6: canManage is true inside a support session, and supportSession says so', async () => {
    h.ctx = accountCtx('admin', { impersonated: true });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      canManage: true,
      supportSession: true,
    });
  });

  it('supportSession is false outside a support session', async () => {
    h.ctx = accountCtx('admin');
    expect((await (await GET()).json()).supportSession).toBe(false);
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
