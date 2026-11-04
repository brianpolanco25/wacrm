import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashInviteToken } from '@/lib/auth/invitations';

// POST /api/platform/accounts/[id]/members/create — «Crear miembro»
// (i12.2). An operator creates a confirmed member with a password: audit
// first, then a short-lived invitation of the company, then the Auth
// signup that the 090 trigger turns into a membership. On trial: the
// guard, validation, who already exists, the seat limit, the order of
// the writes, the clean-up when the signup fails, and that the password
// goes nowhere but to the signup.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  rateOk: true,
  rateKey: null as string | null,
  summary: null as { id: string; name: string; createdAt: string } | null,
  steps: [] as string[],
  audit: [] as Record<string, unknown>[],
  auditId: 'log-1' as string | null,
  existing: null as Record<string, unknown> | null,
  seats: 1,
  limits: { operators: 3 } as Record<string, number | null>,
  invitations: [] as Record<string, unknown>[],
  insertThrows: false,
  created: null as Record<string, unknown> | null,
  outcome: { ok: true, userId: 'new-user' } as
    | { ok: true; userId: string }
    | { ok: false; reason: 'exists' | 'rejected' | 'failed' },
  createThrows: false,
  deleted: [] as [string, string][],
  invited: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

// `platform_admins`: the guard and the operator check of the email.
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
  checkRateLimit: (key: string) => {
    h.rateKey = key;
    return h.rateOk
      ? { success: true, limit: 1, remaining: 1, reset: 0 }
      : { success: false, limit: 1, remaining: 0, reset: Date.now() + 1000 };
  },
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
    if (h.insertThrows) throw new Error('insert failed');
    h.invitations.push(params);
    return { id: 'inv-1', expiresAt: '2026-11-05T00:00:00.000Z' };
  },
  createConfirmedMember: async (params: Record<string, unknown>) => {
    h.steps.push('create');
    h.created = params;
    if (h.createThrows) throw new Error('auth down');
    return h.outcome;
  },
  deleteInvitation: async (accountId: string, invitationId: string) => {
    h.steps.push('delete');
    h.deleted.push([accountId, invitationId]);
  },
  inviteAuthUser: async () => {
    h.invited = true;
    return { ok: true, userId: 'x' };
  },
}));

const { POST } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const OTHER_OPERATOR = '33333333-3333-4333-8333-333333333333';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';

const PASSWORD = 'Clave-Secreta-2026';
const VALID = {
  email: 'ana@acme.test',
  fullName: 'Ana Agent',
  role: 'agent',
  password: PASSWORD,
  reason: 'el alta por enlace no llegó',
};

function call(body: unknown, id = ACCOUNT) {
  return POST(
    new Request(`http://localhost/api/platform/accounts/${id}/members/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR, OTHER_OPERATOR]);
  h.rateOk = true;
  h.rateKey = null;
  h.summary = { id: ACCOUNT, name: 'Company A', createdAt: '2026-01-01' };
  h.steps = [];
  h.audit = [];
  h.auditId = 'log-1';
  h.existing = null;
  h.seats = 1;
  h.limits = { operators: 3 };
  h.invitations = [];
  h.insertThrows = false;
  h.created = null;
  h.outcome = { ok: true, userId: 'new-user' };
  h.createThrows = false;
  h.deleted = [];
  h.invited = false;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

/** The password must not be in the body, the audit, nor any console line. */
async function expectNoPasswordLeak(res: Response) {
  const text = await res.text();
  expect(text).not.toContain(PASSWORD);
  expect(JSON.stringify(h.audit)).not.toContain(PASSWORD);
  expect(
    JSON.stringify([errorSpy.mock.calls, warnSpy.mock.calls], (_k, v) =>
      v instanceof Error ? `${v.name}: ${v.message} ${v.stack}` : v
    )
  ).not.toContain(PASSWORD);
  return text;
}

describe('the guard (R1, R2, R3)', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await call(VALID)).status).toBe(401);
    expect(h.steps).toEqual([]);
  });

  it('403s a company owner', async () => {
    h.user = { id: PLAIN_OWNER };
    expect((await call(VALID)).status).toBe(403);
    expect(h.steps).toEqual([]);
  });

  it('429s past the rate limit, on the bucket of the invitation', async () => {
    h.rateOk = false;
    expect((await call(VALID)).status).toBe(429);
    expect(h.rateKey).toBe(`platform:member:${OPERATOR}`);
    expect(h.steps).toEqual([]);
  });

  it('404s a malformed id and a missing company', async () => {
    expect((await call(VALID, 'nope')).status).toBe(404);
    h.summary = null;
    expect((await call(VALID)).status).toBe(404);
    expect(h.steps).toEqual([]);
  });
});

describe('the request (R4–R8)', () => {
  it.each([
    ['no email', { ...VALID, email: undefined }, 'invalid_email'],
    ['a bad email', { ...VALID, email: 'nope' }, 'invalid_email'],
    ['no name', { ...VALID, fullName: undefined }, 'invalid_name'],
    ['a blank name', { ...VALID, fullName: '   ' }, 'invalid_name'],
    [
      'a 121-char name',
      { ...VALID, fullName: 'a'.repeat(121) },
      'invalid_name',
    ],
    ['the owner role', { ...VALID, role: 'owner' }, 'invalid_role'],
    ['an unknown role', { ...VALID, role: 'root' }, 'invalid_role'],
    ['no password', { ...VALID, password: undefined }, 'invalid_password'],
    [
      'a 7-char password',
      { ...VALID, password: 'a'.repeat(7) },
      'invalid_password',
    ],
    [
      'a 73-char password',
      { ...VALID, password: 'a'.repeat(73) },
      'invalid_password',
    ],
    ['no reason', { ...VALID, reason: undefined }, 'invalid_reason'],
    ['a 9-char reason', { ...VALID, reason: 'a'.repeat(9) }, 'invalid_reason'],
    [
      'a reason of spaces',
      { ...VALID, reason: `  ${'a'.repeat(9)}   ` },
      'invalid_reason',
    ],
  ])('400s %s and writes nothing', async (_label, body, code) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(code);
    expect(h.steps).toEqual([]);
  });

  it('accepts the bounds: a 120-char name, 8- and 72-char passwords', async () => {
    expect((await call({ ...VALID, fullName: 'a'.repeat(120) })).status).toBe(
      201
    );
    expect((await call({ ...VALID, password: 'a'.repeat(8) })).status).toBe(
      201
    );
    expect((await call({ ...VALID, password: 'a'.repeat(72) })).status).toBe(
      201
    );
  });

  it('normalizes the email, trims the name and the reason, but never the password', async () => {
    await call({
      ...VALID,
      email: ' Ana@X.test ',
      fullName: '  Ana  ',
      password: '  abcdefgh  ',
      reason: '   el alta por enlace no llegó  ',
    });
    expect(h.created).toMatchObject({
      email: 'ana@x.test',
      fullName: 'Ana',
      password: '  abcdefgh  ',
    });
    expect(h.audit[0]).toMatchObject({ reason: 'el alta por enlace no llegó' });
  });
});

describe('people who already exist (R9–R11)', () => {
  it('409s someone already in this company', async () => {
    h.existing = {
      userId: 'u-1',
      accountId: ACCOUNT,
      fullName: 'Ana',
      email: VALID.email,
    };
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already_member');
    expect(h.steps).toEqual([]);
  });

  it('409s a platform operator, even from another company', async () => {
    h.existing = {
      userId: OTHER_OPERATOR,
      accountId: OTHER,
      fullName: 'Op',
      email: VALID.email,
    };
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('is_operator');
    expect(h.steps).toEqual([]);
  });

  it('409s someone of another company without saying which one', async () => {
    h.existing = {
      userId: 'u-2',
      accountId: OTHER,
      fullName: 'Ana',
      email: VALID.email,
    };
    const res = await call(VALID);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
    expect(body.code).toBe('email_exists');
    expect(JSON.stringify(body)).not.toContain(OTHER);
    expect(JSON.stringify(body)).not.toContain('u-2');
    expect(h.steps).toEqual([]);
  });
});

describe('the seats (R12)', () => {
  it('402s a company whose plan is full, writing nothing', async () => {
    h.seats = 3;
    const res = await call(VALID);
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe('plan_limit_reached');
    expect(h.steps).toEqual([]);
  });
});

describe('the writes (R13, R15, R16)', () => {
  it('writes the audit first, then the invitation, then the signup', async () => {
    const res = await call(VALID);
    expect(res.status).toBe(201);
    expect(h.steps).toEqual(['audit', 'invitation', 'create']);
    expect(h.audit[0]).toEqual({
      action: 'member_create',
      actorUserId: OPERATOR,
      accountId: ACCOUNT,
      accountName: 'Company A',
      reason: VALID.reason,
      details: {
        email: 'ana@acme.test',
        role: 'agent',
        full_name: 'Ana Agent',
      },
    });
  });

  it('does nothing when the audit cannot be written', async () => {
    h.auditId = null;
    const res = await call(VALID);
    expect(res.status).toBe(500);
    expect(h.steps).toEqual(['audit']);
    await expectNoPasswordLeak(res);
  });

  it('writes a one-day invitation of THIS company, and signs up with its token', async () => {
    const before = Date.now();
    await call(VALID);
    const inv = h.invitations[0];
    expect(inv).toMatchObject({
      accountId: ACCOUNT,
      role: 'agent',
      createdBy: OPERATOR,
      label: 'ana@acme.test',
    });
    const expires = (inv.expiresAt as Date).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 86_400_000 - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 86_400_000 + 1000);

    const token = h.created!.inviteToken as string;
    expect(typeof token).toBe('string');
    expect(inv.tokenHash).toBe(hashInviteToken(token));
    expect(h.created).toEqual({
      email: 'ana@acme.test',
      password: PASSWORD,
      fullName: 'Ana Agent',
      inviteToken: token,
    });
  });

  it('201s the member — no password, no token, no link, no email', async () => {
    const res = await call(VALID);
    expect(res.status).toBe(201);
    const text = await expectNoPasswordLeak(res);
    expect(JSON.parse(text)).toEqual({
      member: {
        userId: 'new-user',
        email: 'ana@acme.test',
        fullName: 'Ana Agent',
        role: 'agent',
      },
    });
    expect(text).not.toContain(h.created!.inviteToken as string);
    expect(text).not.toContain('/join/');
    expect(h.invited).toBe(false);
    expect(h.deleted).toEqual([]);
  });
});

describe('when the signup does not happen (R17–R19)', () => {
  it('"exists": deletes the invitation and 409s email_exists', async () => {
    h.outcome = { ok: false, reason: 'exists' };
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect(h.steps).toEqual(['audit', 'invitation', 'create', 'delete']);
    expect(h.deleted).toEqual([[ACCOUNT, 'inv-1']]);
    expect(JSON.parse(await expectNoPasswordLeak(res)).code).toBe(
      'email_exists'
    );
  });

  it('"rejected": deletes the invitation and 409s rejected', async () => {
    h.outcome = { ok: false, reason: 'rejected' };
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect(h.deleted).toEqual([[ACCOUNT, 'inv-1']]);
    expect(JSON.parse(await expectNoPasswordLeak(res)).code).toBe('rejected');
  });

  it('"failed": deletes the invitation and 502s', async () => {
    h.outcome = { ok: false, reason: 'failed' };
    const res = await call(VALID);
    expect(res.status).toBe(502);
    expect(h.deleted).toEqual([[ACCOUNT, 'inv-1']]);
    expect(JSON.parse(await expectNoPasswordLeak(res)).code).toBe(
      'create_failed'
    );
  });

  it('an exception after the invitation deletes it and 500s', async () => {
    h.createThrows = true;
    const res = await call(VALID);
    expect(res.status).toBe(500);
    expect(h.steps).toEqual(['audit', 'invitation', 'create', 'delete']);
    expect(h.deleted).toEqual([[ACCOUNT, 'inv-1']]);
    expect(errorSpy).toHaveBeenCalled();
    await expectNoPasswordLeak(res);
  });

  it('an exception writing the invitation deletes nothing and 500s', async () => {
    h.insertThrows = true;
    const res = await call(VALID);
    expect(res.status).toBe(500);
    expect(h.steps).toEqual(['audit', 'invitation']);
    expect(h.deleted).toEqual([]);
    await expectNoPasswordLeak(res);
  });

  it('409 responses from validation never carry the password either', async () => {
    h.existing = {
      userId: 'u-2',
      accountId: OTHER,
      fullName: null,
      email: VALID.email,
    };
    await expectNoPasswordLeak(await call(VALID));
  });
});
