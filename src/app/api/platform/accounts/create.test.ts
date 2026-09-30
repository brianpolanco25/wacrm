import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/accounts — «Crear empresa» (s9.4). What is on
// trial: the guard, the validation (reason ≥ 10 like every line of the
// log), the 409 for an email that already has a user, the audit BEFORE
// the invite, and what happens after it (the account the trigger made
// is renamed and, optionally, given a plan by hand).

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  steps: [] as string[],
  audit: [] as Record<string, unknown>[],
  auditId: 'log-1' as string | null,
  attached: [] as [string, string][],
  existing: null as Record<string, unknown> | null,
  plans: new Set(['inicio', 'pro', 'negocio', 'ilimitado']),
  invite: { ok: true, userId: 'new-owner' } as
    { ok: true; userId: string } | { ok: false; reason: 'exists' | 'failed' },
  inviteArgs: null as Record<string, unknown> | null,
  ownedAccount: { id: 'acct-new', name: 'owner@acme.test' } as {
    id: string;
    name: string;
  } | null,
  renamed: [] as [string, string][],
  overrides: [] as Record<string, unknown>[],
  overrideResult: { ok: true, fromPlan: 'pro', fromProvider: 'paypal' } as
    | { ok: true; fromPlan: string | null; fromProvider: string | null }
    | { ok: false; reason: string },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: (_c: string, userId: string) => ({
          maybeSingle: async () => ({
            data: h.admins.has(userId)
              ? { user_id: userId, granted_at: null, note: null }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, reset: 0 }),
}));

vi.mock('@/lib/platform/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/audit')>()),
  recordPlatformAction: async (params: Record<string, unknown>) => {
    h.steps.push('audit');
    h.audit.push(params);
    return h.auditId;
  },
  attachAccountToAuditRow: async (logId: string, accountId: string) => {
    h.steps.push('attach');
    h.attached.push([logId, accountId]);
  },
}));

vi.mock('@/lib/platform/provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/provisioning')>()),
  planExists: async (id: string) => h.plans.has(id),
  findProfileByEmail: async () => h.existing,
  inviteAuthUser: async (args: Record<string, unknown>) => {
    h.steps.push('invite');
    h.inviteArgs = args;
    return h.invite;
  },
  findAccountOwnedBy: async () => h.ownedAccount,
  renameAccount: async (id: string, name: string) => {
    h.steps.push('rename');
    h.renamed.push([id, name]);
  },
  overridePlan: async (params: Record<string, unknown>) => {
    h.steps.push('plan');
    h.overrides.push(params);
    return h.overrideResult;
  },
}));

const { POST } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const REASON = 'new customer from the sales call, ticket 7';

function call(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/platform/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );
}

const VALID = {
  name: '  Acme SRL  ',
  ownerEmail: ' Owner@Acme.test ',
  ownerName: 'Ana Owner',
  reason: REASON,
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.steps = [];
  h.audit = [];
  h.auditId = 'log-1';
  h.attached = [];
  h.existing = null;
  h.invite = { ok: true, userId: 'new-owner' };
  h.inviteArgs = null;
  h.ownedAccount = { id: 'acct-new', name: 'owner@acme.test' };
  h.renamed = [];
  h.overrides = [];
  h.overrideResult = { ok: true, fromPlan: 'pro', fromProvider: null };
});

describe('the guard', () => {
  it('401s a visitor with no session, and invites nobody', async () => {
    h.user = null;
    expect((await call(VALID)).status).toBe(401);
    expect(h.steps).toEqual([]);
  });

  it('403s a company owner', async () => {
    h.user = { id: PLAIN_OWNER };
    expect((await call(VALID)).status).toBe(403);
    expect(h.steps).toEqual([]);
  });
});

describe('the request', () => {
  it.each([
    ['no name', { ...VALID, name: '   ' }],
    ['a name too long', { ...VALID, name: 'x'.repeat(121) }],
    ['no email', { ...VALID, ownerEmail: undefined }],
    ['a bad email', { ...VALID, ownerEmail: 'owner-at-acme' }],
    ['no reason', { ...VALID, reason: undefined }],
    ['a short reason', { ...VALID, reason: '  too short ' }],
    ['an unknown plan', { ...VALID, planId: 'platinum' }],
    ['a plan that is not a string', { ...VALID, planId: 42 }],
  ])('400s %s, and writes nothing', async (_label, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(h.steps).toEqual([]);
  });

  it('409s an email that already has a user — before writing anything', async () => {
    h.existing = { userId: 'someone', accountId: 'acct-x' };
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('email_exists');
    expect(h.steps).toEqual([]);
  });
});

describe('creating the company', () => {
  it('audits, invites, attaches, renames — in that order — and answers 201', async () => {
    const res = await call(VALID, { host: 'app.example.test' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      accountId: 'acct-new',
      userId: 'new-owner',
      name: 'Acme SRL',
      planId: null,
    });

    expect(h.steps).toEqual(['audit', 'invite', 'attach', 'rename']);
    expect(h.audit).toEqual([
      {
        action: 'account_create',
        actorUserId: OPERATOR,
        accountId: null,
        accountName: 'Acme SRL',
        reason: REASON,
        details: {
          owner_email: 'owner@acme.test',
          owner_name: 'Ana Owner',
          plan_id: null,
        },
      },
    ]);
    expect(h.inviteArgs).toEqual({
      email: 'owner@acme.test',
      fullName: 'Ana Owner',
      // s9.8: through /auth/callback, then /reset-password.
      redirectTo:
        'http://app.example.test/auth/callback?next=%2Freset-password',
    });
    const redirect = new URL(h.inviteArgs!.redirectTo as string);
    expect(redirect.origin).toBe('http://app.example.test');
    expect(redirect.pathname).toBe('/auth/callback');
    expect(redirect.searchParams.get('next')).toBe('/reset-password');
    expect(redirect.searchParams.get('invite')).toBeNull();
    expect(h.attached).toEqual([['log-1', 'acct-new']]);
    expect(h.renamed).toEqual([['acct-new', 'Acme SRL']]);
  });

  it('builds the redirect from NEXT_PUBLIC_SITE_URL when it is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com/');
    await call(VALID, { host: 'evil.test' });
    expect(h.inviteArgs?.redirectTo).toBe(
      'https://crm.example.com/auth/callback?next=%2Freset-password'
    );
  });

  it('gives the new company the plan by hand, with the same reason', async () => {
    const res = await call({ ...VALID, planId: 'ilimitado' });
    expect(res.status).toBe(201);
    expect((await res.json()).planId).toBe('ilimitado');
    expect(h.steps).toEqual(['audit', 'invite', 'attach', 'rename', 'plan']);
    expect(h.overrides).toEqual([
      {
        accountId: 'acct-new',
        accountName: 'Acme SRL',
        planId: 'ilimitado',
        actorUserId: OPERATOR,
        reason: REASON,
      },
    ]);
  });

  it('still reports the company when the plan could not be given', async () => {
    h.overrideResult = { ok: false, reason: 'audit_failed' };
    const res = await call({ ...VALID, planId: 'pro' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      accountId: 'acct-new',
      planId: null,
      planError: 'audit_failed',
    });
  });

  it('invites NOBODY when the trail cannot be written', async () => {
    h.auditId = null;
    const res = await call(VALID);
    expect(res.status).toBe(500);
    expect(h.steps).toEqual(['audit']);
  });

  it('409s when Supabase says the user exists (a race with a signup)', async () => {
    h.invite = { ok: false, reason: 'exists' };
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect(h.steps).toEqual(['audit', 'invite']);
  });

  it('502s when the invitation could not be sent, and renames nothing', async () => {
    h.invite = { ok: false, reason: 'failed' };
    const res = await call(VALID);
    expect(res.status).toBe(502);
    expect(h.renamed).toEqual([]);
  });

  it('says so when the trigger did not create the company', async () => {
    h.ownedAccount = null;
    const res = await call(VALID);
    expect(res.status).toBe(500);
    expect((await res.json()).userId).toBe('new-owner');
    expect(h.renamed).toEqual([]);
  });
});
