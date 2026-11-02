import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/accounts/[id]/members/[userId]/password — an
// operator sets a member's password by hand. On trial: the guard,
// validation, that the person must belong to the company of the file,
// the audit BEFORE the change, the refusal of another operator, and that
// the password never reaches the log.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  summary: null as { id: string; name: string; createdAt: string } | null,
  steps: [] as string[],
  audit: [] as Record<string, unknown>[],
  auditId: 'log-1' as string | null,
  member: null as { userId: string; email: string | null } | null,
  memberLookup: null as [string, string] | null,
  outcome: { ok: true } as
    { ok: true } | { ok: false; reason: 'operator' | 'failed' },
  set: null as Record<string, unknown> | null,
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
  findMemberForPasswordChange: async (accountId: string, userId: string) => {
    h.memberLookup = [accountId, userId];
    return h.member;
  },
  setMemberPassword: async (params: Record<string, unknown>) => {
    h.steps.push('password');
    h.set = params;
    return h.outcome;
  },
}));

const { POST } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000002';

function call(body: unknown, id = ACCOUNT, userId = MEMBER) {
  return POST(
    new Request(
      `http://localhost/api/platform/accounts/${id}/members/${userId}/password`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    ),
    { params: Promise.resolve({ id, userId }) }
  );
}

const VALID = { password: 'Nueva-clave-2026', reason: 'cliente bloqueado' };

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.summary = { id: ACCOUNT, name: 'Company A', createdAt: '2026-01-01' };
  h.steps = [];
  h.audit = [];
  h.auditId = 'log-1';
  h.member = { userId: MEMBER, email: 'ana@acme.test' };
  h.memberLookup = null;
  h.outcome = { ok: true };
  h.set = null;
});

describe('the guard', () => {
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
});

describe('the request', () => {
  it.each([
    ['no password', { reason: VALID.reason }],
    ['a short password', { ...VALID, password: 'corta' }],
    ['a password past 72 characters', { ...VALID, password: 'a'.repeat(73) }],
    ['no reason', { password: VALID.password }],
    ['a short reason', { ...VALID, reason: 'ya' }],
  ])('400s %s and changes nothing', async (_label, body) => {
    expect((await call(body)).status).toBe(400);
    expect(h.steps).toEqual([]);
  });

  it('404s malformed ids, a missing company and a person from another company', async () => {
    expect((await call(VALID, 'nope')).status).toBe(404);
    expect((await call(VALID, ACCOUNT, 'nope')).status).toBe(404);
    h.summary = null;
    expect((await call(VALID)).status).toBe(404);
    h.summary = { id: ACCOUNT, name: 'Company A', createdAt: '2026-01-01' };
    h.member = null;
    expect((await call(VALID)).status).toBe(404);
    expect(h.steps).toEqual([]);
  });
});

describe('the change', () => {
  it('looks the person up inside the company of the file', async () => {
    await call(VALID);
    expect(h.memberLookup).toEqual([ACCOUNT, MEMBER]);
  });

  it('writes the audit first, then sets the password', async () => {
    const res = await call(VALID);
    expect(res.status).toBe(200);
    expect(h.steps).toEqual(['audit', 'password']);
    expect(h.set).toEqual({ userId: MEMBER, password: VALID.password });
    expect(h.audit[0]).toMatchObject({
      action: 'password_set',
      actorUserId: OPERATOR,
      accountId: ACCOUNT,
      reason: VALID.reason,
    });
  });

  it('never puts the password in the log', async () => {
    await call(VALID);
    expect(JSON.stringify(h.audit)).not.toContain(VALID.password);
  });

  it('does nothing when the audit cannot be written', async () => {
    h.auditId = null;
    expect((await call(VALID)).status).toBe(500);
    expect(h.steps).toEqual(['audit']);
  });

  it("refuses another operator's password with 409", async () => {
    h.outcome = { ok: false, reason: 'operator' };
    const res = await call(VALID);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('is_operator');
  });

  it('502s when Supabase refuses the change', async () => {
    h.outcome = { ok: false, reason: 'failed' };
    expect((await call(VALID)).status).toBe(502);
  });
});
