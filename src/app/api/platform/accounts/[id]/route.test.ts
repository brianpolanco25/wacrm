import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/platform/accounts/[id] — one account's file. The id comes off
// the URL, so it is attacker-controlled: the only thing that makes
// reading somebody else's company legitimate is `requirePlatformAdmin()`.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  detailCalls: [] as string[],
  detail: null as unknown,
  detailError: null as unknown,
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

vi.mock('@/lib/platform/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/accounts')>()),
  loadAccountDetail: async (id: string) => {
    h.detailCalls.push(id);
    if (h.detailError) throw h.detailError;
    return h.detail;
  },
}));

const { GET } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const TARGET = 'aaaaaaaa-0000-4000-8000-000000000001';

function call(id: string) {
  return GET(new Request(`http://localhost/api/platform/accounts/${id}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.detailCalls = [];
  h.detailError = null;
  h.detail = {
    accountId: TARGET,
    name: 'Company A',
    planId: 'pro',
    subscriptionStatus: 'active',
    usage: [{ metric: 'messages_out', used: 4200, limit: 15000, percent: 28 }],
    numbers: [{ id: 'cfg-1', status: 'connected' }],
    billingHistory: [],
    audit: [],
  };
});

describe('the guard', () => {
  it('401s a visitor with no session', async () => {
    h.user = null;
    expect((await call(TARGET)).status).toBe(401);
    expect(h.detailCalls).toEqual([]);
  });

  it("403s a company owner asking about somebody else's company", async () => {
    h.user = { id: PLAIN_OWNER };
    const res = await call(TARGET);
    expect(res.status).toBe(403);
    // Nothing about that account was read, so nothing about it can leak.
    expect(h.detailCalls).toEqual([]);
  });

  it('403s a company owner asking about THEIR OWN company too', async () => {
    // The panel is not a second way into your own data: /api/billing/*
    // is where a tenant reads their own subscription, with a role check.
    h.user = { id: PLAIN_OWNER };
    expect((await call(TARGET)).status).toBe(403);
  });
});

describe('the file', () => {
  it('returns consumption, numbers and the trail for a platform admin', async () => {
    const res = await call(TARGET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBe(TARGET);
    expect(body.usage[0]).toMatchObject({ metric: 'messages_out', used: 4200 });
    expect(body.numbers).toHaveLength(1);
    expect(h.detailCalls).toEqual([TARGET]);
  });

  it('404s an account that does not exist', async () => {
    h.detail = null;
    const res = await call('dddddddd-0000-4000-8000-00000000dead');
    expect(res.status).toBe(404);
  });

  it('404s a malformed id without going anywhere near the database', async () => {
    const res = await call('not-a-uuid');
    expect(res.status).toBe(404);
    expect(h.detailCalls).toEqual([]);
  });

  it('500s without echoing the database error', async () => {
    h.detailError = new Error('column "manual_hold_at" does not exist');
    const res = await call(TARGET);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('manual_hold_at');
  });
});
