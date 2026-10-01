import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/billing/statements and POST …/[sid]/claim-paid (s10.4): the
// guard and the validation. The leak between companies is covered with
// both accounts seeded in `src/lib/security/tenant-isolation.test.ts`
// › «statements (s10.4, service role)».

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  assertNotSupportSession: vi.fn(),
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: h.requireRole,
  assertNotSupportSession: h.assertNotSupportSession,
}));

vi.mock('@/lib/flows/admin-client', async () => {
  const mod = await import('@/lib/security/fake-supabase');
  const forward = mod.forwardingClient(() => h.db.admin);
  return { supabaseAdmin: () => forward };
});

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, reset: 0 }),
}));

const { ForbiddenError, UnauthorizedError } =
  await import('@/lib/auth/account');
const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { GET } = await import('./route');
const { POST } = await import('./[sid]/claim-paid/route');

const A = 'acct-a';
const ST = 'aaaaaaaa-5555-4000-8000-000000000001';

function claim(body: unknown, sid = ST) {
  return POST(
    new Request(`http://localhost/api/billing/statements/${sid}/claim-paid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ sid }) }
  );
}

beforeEach(() => {
  h.db = new FakeDatabase({
    statements: [
      {
        id: ST,
        account_id: A,
        period_start: '2026-10-01T00:00:00.000Z',
        period_end: '2026-11-01T00:00:00.000Z',
        status: 'issued',
        due_at: '2026-11-04T00:00:00.000Z',
        total_usd: 1036,
        usage: {},
      },
    ],
  });
  h.requireRole.mockReset().mockResolvedValue({
    accountId: A,
    userId: 'user-a',
    role: 'admin',
    impersonation: null,
  });
  h.assertNotSupportSession.mockReset().mockResolvedValue(undefined);
});

describe('the guard', () => {
  it('401s without a session, on both', async () => {
    h.requireRole.mockRejectedValue(new UnauthorizedError());
    expect((await GET()).status).toBe(401);
    expect((await claim({})).status).toBe(401);
    expect(h.db.log).toEqual([]);
  });

  it('403s below admin, on both', async () => {
    h.requireRole.mockRejectedValue(
      new ForbiddenError("This action requires the 'admin' role or higher")
    );
    expect((await GET()).status).toBe(403);
    expect((await claim({})).status).toBe(403);
    expect(h.db.log).toEqual([]);
  });

  it('asks for admin+ and stays reachable while the account is read-only', async () => {
    await GET();
    await claim({});
    for (const call of h.requireRole.mock.calls) {
      expect(call).toEqual(['admin', { allowReadOnly: true }]);
    }
  });

  it('«Ya pagué» is never sent from a support session (it speaks for the customer)', async () => {
    h.assertNotSupportSession.mockRejectedValue(
      new ForbiddenError('Not available during a support session')
    );
    expect((await claim({})).status).toBe(403);
    expect(h.db.rows('statements')[0].claimed_paid_at).toBeUndefined();
  });
});

describe('«Ya pagué»', () => {
  it('400s a note that is not text or is too long, and writes nothing', async () => {
    expect((await claim({ note: 42 })).status).toBe(400);
    expect((await claim({ note: 'x'.repeat(501) })).status).toBe(400);
    expect(h.db.rows('statements')[0].claimed_paid_at).toBeUndefined();
  });

  it('404s a malformed id', async () => {
    expect((await claim({}, 'nope')).status).toBe(404);
  });

  it('409s a statement that is no longer pending', async () => {
    h.db.rows('statements')[0].status = 'paid';
    const res = await claim({});
    expect(res.status).toBe(409);
    expect(h.db.rows('statements')[0].claimed_paid_at).toBeUndefined();
  });

  it('works without a note, and never changes the status', async () => {
    const res = await claim({});
    expect(res.status).toBe(200);
    expect(h.db.rows('statements')[0]).toMatchObject({
      status: 'issued',
      claim_note: null,
      claimed_by: 'user-a',
    });
  });
});
