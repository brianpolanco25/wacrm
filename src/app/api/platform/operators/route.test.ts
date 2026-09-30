import { beforeEach, describe, expect, it, vi } from 'vitest';

// /api/platform/operators (s9.4): list, grant, and — in [userId] —
// revoke. The two hard rules of revocation (not oneself, never the last
// operator) live in SQL under a lock (071, checked against a real base in
// progress/checks_platform-provisioning.sql); here, that the route asks
// for them and maps each answer to the right status.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  operators: [] as Record<string, unknown>[],
  listError: null as unknown,
  person: null as Record<string, unknown> | null,
  grants: [] as Record<string, unknown>[],
  revokes: [] as Record<string, unknown>[],
  outcome: { ok: true } as { ok: true } | { ok: false; reason: string },
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

vi.mock('@/lib/platform/provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/provisioning')>()),
  listOperators: async () => {
    if (h.listError) throw h.listError;
    return h.operators;
  },
  findProfileByEmail: async () => h.person,
  grantOperator: async (params: Record<string, unknown>) => {
    h.grants.push(params);
    return h.outcome;
  },
  revokeOperator: async (params: Record<string, unknown>) => {
    h.revokes.push(params);
    return h.outcome;
  },
}));

const { GET, POST } = await import('./route');
const { DELETE } = await import('./[userId]/route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const OTHER_OP = '33333333-3333-4333-8333-333333333333';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const NOTE = 'new support hire, ticket 12';

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/platform/operators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

function del(userId: string, body: unknown = { reason: NOTE }) {
  return DELETE(
    new Request(`http://localhost/api/platform/operators/${userId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId }) }
  );
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR, OTHER_OP]);
  h.operators = [
    {
      userId: OPERATOR,
      email: 'op@x.test',
      fullName: 'Op',
      grantedAt: null,
      grantedBy: null,
      note: null,
    },
  ];
  h.listError = null;
  h.person = {
    userId: OTHER_OP,
    accountId: 'acct-9',
    email: 'bea@x.test',
    fullName: 'Bea',
  };
  h.grants = [];
  h.revokes = [];
  h.outcome = { ok: true };
});

describe('the guard, on all three verbs', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await GET()).status).toBe(401);
    expect((await post({ email: 'bea@x.test', note: NOTE })).status).toBe(401);
    expect((await del(OTHER_OP)).status).toBe(401);
    expect(h.grants).toEqual([]);
    expect(h.revokes).toEqual([]);
  });

  it('403s a company owner — he cannot promote himself', async () => {
    h.user = { id: PLAIN_OWNER };
    expect((await GET()).status).toBe(403);
    expect((await post({ email: 'owner@x.test', note: NOTE })).status).toBe(
      403
    );
    expect((await del(OPERATOR)).status).toBe(403);
    expect(h.grants).toEqual([]);
    expect(h.revokes).toEqual([]);
  });
});

describe('GET', () => {
  it('lists the operators and says who is asking', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      operators: h.operators,
      currentUserId: OPERATOR,
    });
  });

  it('500s without leaking the error', async () => {
    h.listError = new Error('secret detail');
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});

describe('POST — grant', () => {
  it('grants an existing user, found by email, with the note as the reason', async () => {
    const res = await post({ email: ' Bea@X.test ', note: `  ${NOTE} ` });
    expect(res.status).toBe(201);
    expect(h.grants).toEqual([
      { userId: OTHER_OP, actorUserId: OPERATOR, reason: NOTE },
    ]);
  });

  it('404s an email with no user: they must sign up first', async () => {
    h.person = null;
    const res = await post({ email: 'ghost@x.test', note: NOTE });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/primero debe registrarse/);
    expect(h.grants).toEqual([]);
  });

  it('400s a bad email or a short note', async () => {
    expect((await post({ email: 'nope', note: NOTE })).status).toBe(400);
    expect((await post({ email: 'bea@x.test', note: 'short' })).status).toBe(
      400
    );
    expect((await post({ email: 'bea@x.test' })).status).toBe(400);
    expect(h.grants).toEqual([]);
  });

  it('409s someone who is already an operator', async () => {
    h.outcome = { ok: false, reason: 'exists' };
    expect((await post({ email: 'bea@x.test', note: NOTE })).status).toBe(409);
  });
});

describe('DELETE — revoke', () => {
  it('revokes another operator, with the reason', async () => {
    const res = await del(OTHER_OP);
    expect(res.status).toBe(200);
    expect(h.revokes).toEqual([
      { userId: OTHER_OP, actorUserId: OPERATOR, reason: NOTE },
    ]);
  });

  it('400s revoking oneself, without even asking the database', async () => {
    const res = await del(OPERATOR);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('self');
    expect(h.revokes).toEqual([]);
  });

  it('400s when the database says self (the lock-held check)', async () => {
    h.outcome = { ok: false, reason: 'self' };
    expect((await del(OTHER_OP)).status).toBe(400);
  });

  it('400s revoking the last operator', async () => {
    h.outcome = { ok: false, reason: 'last' };
    const res = await del(OTHER_OP);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('last');
  });

  it('404s someone who is not an operator, and a malformed id', async () => {
    h.outcome = { ok: false, reason: 'absent' };
    expect((await del(OTHER_OP)).status).toBe(404);
    expect((await del('not-a-uuid')).status).toBe(404);
  });

  it('400s a missing or short reason', async () => {
    expect((await del(OTHER_OP, {})).status).toBe(400);
    expect((await del(OTHER_OP, { reason: 'bye' })).status).toBe(400);
    expect(h.revokes).toEqual([]);
  });
});
