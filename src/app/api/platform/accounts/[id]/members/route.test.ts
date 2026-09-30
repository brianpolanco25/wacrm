import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/accounts/[id]/members — «Añadir miembro» (s9.4).
// It reuses the invitation of the Members tab (`account_invitations` +
// `/join/<token>` + `redeem_invitation`), written for the company of
// the file. On trial: the guard, validation, 409 for someone already in
// the company, the seat limit, the audit before the invitation, and who
// gets an email.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  summary: null as { id: string; name: string; createdAt: string } | null,
  steps: [] as string[],
  audit: [] as Record<string, unknown>[],
  auditId: 'log-1' as string | null,
  existing: null as Record<string, unknown> | null,
  seats: 1,
  limits: { operators: 3 } as Record<string, number | null>,
  invitations: [] as Record<string, unknown>[],
  inviteArgs: null as Record<string, unknown> | null,
  inviteOk: true,
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

vi.mock('@/lib/platform/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/accounts')>()),
  loadAccountSummary: async () => h.summary,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  getEntitlements: async () => ({
    planId: 'inicio',
    status: 'active',
    limits: h.limits,
    features: [],
    readOnly: false,
  }),
}));

vi.mock('@/lib/platform/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/audit')>()),
  recordPlatformAction: async (params: Record<string, unknown>) => {
    h.steps.push('audit');
    h.audit.push(params);
    return h.auditId;
  },
}));

vi.mock('@/lib/platform/provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/provisioning')>()),
  findProfileByEmail: async () => h.existing,
  countSeats: async () => h.seats,
  insertInvitation: async (params: Record<string, unknown>) => {
    h.steps.push('invitation');
    h.invitations.push(params);
    return { id: 'inv-1', expiresAt: '2026-10-07T00:00:00.000Z' };
  },
  inviteAuthUser: async (args: Record<string, unknown>) => {
    h.steps.push('email');
    h.inviteArgs = args;
    return h.inviteOk
      ? { ok: true, userId: 'new-user' }
      : { ok: false, reason: 'failed' };
  },
}));

const { POST } = await import('./route');
const { hashInviteToken } = await import('@/lib/auth/invitations');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const TARGET = 'aaaaaaaa-0000-4000-8000-000000000001';

function call(body: unknown, id = TARGET) {
  return POST(
    new Request(`http://localhost/api/platform/accounts/${id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'app.test' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

const VALID = { email: 'New.Agent@Acme.test', role: 'agent' };

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.summary = { id: TARGET, name: 'Company A', createdAt: '2026-01-01' };
  h.steps = [];
  h.audit = [];
  h.auditId = 'log-1';
  h.existing = null;
  h.seats = 1;
  h.limits = { operators: 3 };
  h.invitations = [];
  h.inviteArgs = null;
  h.inviteOk = true;
});

describe('the guard', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await call(VALID)).status).toBe(401);
    expect(h.steps).toEqual([]);
  });

  it('403s a company owner — he cannot add people to another company', async () => {
    h.user = { id: PLAIN_OWNER };
    expect((await call(VALID)).status).toBe(403);
    expect(h.steps).toEqual([]);
  });
});

describe('the request', () => {
  it.each([
    ['a bad email', { ...VALID, email: 'nope' }],
    ['no role', { email: VALID.email }],
    ['the owner role', { ...VALID, role: 'owner' }],
    ['a made-up role', { ...VALID, role: 'root' }],
  ])('400s %s', async (_label, body) => {
    expect((await call(body)).status).toBe(400);
    expect(h.steps).toEqual([]);
  });

  it('404s a malformed id and a company that does not exist', async () => {
    expect((await call(VALID, 'nope')).status).toBe(404);
    h.summary = null;
    expect((await call(VALID)).status).toBe(404);
    expect(h.steps).toEqual([]);
  });

  it('409s someone who is already in this company', async () => {
    h.existing = { userId: 'u9', accountId: TARGET };
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already_member');
    expect(h.steps).toEqual([]);
  });

  it('refuses past the seat limit of the plan, like the Members tab', async () => {
    h.seats = 3;
    const res = await call(VALID);
    expect(res.status).toBe(402);
    expect(h.steps).toEqual([]);
  });
});

describe('inviting', () => {
  it('audits, writes the invitation for THIS company, then emails a new person', async () => {
    const res = await call(VALID);
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(h.steps).toEqual(['audit', 'invitation', 'email']);
    expect(h.audit[0]).toMatchObject({
      action: 'member_invite',
      actorUserId: OPERATOR,
      accountId: TARGET,
      accountName: 'Company A',
      details: {
        email: 'new.agent@acme.test',
        role: 'agent',
        existing_user: false,
      },
    });
    expect((h.audit[0].reason as string).length).toBeGreaterThanOrEqual(10);

    expect(h.invitations[0]).toMatchObject({
      accountId: TARGET,
      role: 'agent',
      createdBy: OPERATOR,
      label: 'new.agent@acme.test',
    });

    // The link is the /join/<token> of the Members tab, and its token is
    // the one whose hash was stored.
    expect(body.url).toMatch(/^http:\/\/app\.test\/join\//);
    const token = body.url.split('/join/')[1];
    expect(hashInviteToken(token)).toBe(h.invitations[0].tokenHash);
    // s9.8: the email goes through /auth/callback → /reset-password and
    // then /join/<token>; `body.url` stays the link for the operator.
    expect(h.inviteArgs?.email).toBe('new.agent@acme.test');
    const redirect = new URL(h.inviteArgs!.redirectTo as string);
    expect(redirect.origin).toBe('http://app.test');
    expect(redirect.pathname).toBe('/auth/callback');
    expect(redirect.searchParams.get('next')).toBe('/reset-password');
    expect(redirect.searchParams.get('invite')).toBe(token);
    expect(body.emailed).toBe(true);
  });

  it('does not email someone who already has a user: the link is for the operator to share', async () => {
    h.existing = { userId: 'u9', accountId: 'another-company' };
    const res = await call(VALID);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(h.steps).toEqual(['audit', 'invitation']);
    expect(body.emailed).toBe(false);
    expect(body.url).toContain('/join/');
    expect(h.audit[0].details).toMatchObject({ existing_user: true });
  });

  it('still hands back the link when the email could not be sent', async () => {
    h.inviteOk = false;
    const res = await call(VALID);
    expect(res.status).toBe(201);
    expect((await res.json()).emailed).toBe(false);
  });

  it('invites NOBODY when the trail cannot be written', async () => {
    h.auditId = null;
    expect((await call(VALID)).status).toBe(500);
    expect(h.steps).toEqual(['audit']);
  });

  it('lets an unlimited plan invite past any number', async () => {
    h.limits = { operators: null };
    h.seats = 500;
    expect((await call(VALID)).status).toBe(201);
  });
});
