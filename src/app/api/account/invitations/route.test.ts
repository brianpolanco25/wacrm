import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 — `operators`.
//
// Seats are a STOCK limit: members PLUS outstanding invitations. Counting
// only members would let an admin on a 3-seat plan hand out ten links and
// discover the cap when the fourth person redeems one — at which point
// there is no polite way to refuse them.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getEntitlements: vi.fn(),
  state: {
    memberCount: 1,
    pendingCount: 0,
    memberError: null as { message: string } | null,
    pendingError: null as { message: string } | null,
    inserted: null as Record<string, unknown> | null,
    countedFilters: [] as {
      table: string;
      counting: boolean;
      filters: [string, unknown][];
    }[],
  },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  getEntitlements: mocks.getEntitlements,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));

import { POST } from './route';

function supabaseMock() {
  return {
    from: (table: string) => {
      const entry = {
        table,
        counting: false,
        filters: [] as [string, unknown][],
      };
      mocks.state.countedFilters.push(entry);
      const chain: Record<string, unknown> = {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          if (opts?.head) entry.counting = true;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          entry.filters.push([col, val]);
          return chain;
        },
        is: () => chain,
        gt: () => chain,
        insert: (row: Record<string, unknown>) => {
          mocks.state.inserted = row;
          return chain;
        },
        single: async () => ({
          data: {
            id: 'inv-1',
            role: 'agent',
            label: null,
            expires_at: '2026-10-01T00:00:00Z',
            created_at: '2026-09-01T00:00:00Z',
          },
          error: null,
        }),
        // The head:true counts resolve on await.
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'profiles') {
            return resolve({
              count: mocks.state.memberCount,
              error: mocks.state.memberError,
            });
          }
          if (table === 'account_invitations') {
            return resolve({
              count: mocks.state.pendingCount,
              error: mocks.state.pendingError,
            });
          }
          return resolve({ count: 0, error: null });
        },
      };
      return chain;
    },
  };
}

function entitlements(operators: number | null) {
  return {
    planId: 'inicio',
    status: 'active',
    limits: { operators },
    features: [],
    readOnly: false,
    trialEndsAt: null,
  };
}

function post(body: Record<string, unknown> = { role: 'agent' }) {
  return POST(
    new Request('https://crm.example.com/api/account/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  mocks.state.memberCount = 1;
  mocks.state.pendingCount = 0;
  mocks.state.memberError = null;
  mocks.state.pendingError = null;
  mocks.state.inserted = null;
  mocks.state.countedFilters = [];
  mocks.requireRole.mockReset();
  mocks.requireRole.mockResolvedValue({
    supabase: supabaseMock(),
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Acme' },
  });
  mocks.getEntitlements.mockReset();
  mocks.getEntitlements.mockResolvedValue(entitlements(3));
});

describe('POST /api/account/invitations — operators (fase 3 §4)', () => {
  it('issues the invitation while seats remain', async () => {
    mocks.state.memberCount = 1;
    mocks.state.pendingCount = 1;
    const res = await post();
    expect(res.status).toBe(201);
    expect(mocks.state.inserted).toMatchObject({ account_id: 'acct-1' });
  });

  it('counts outstanding invitations as occupied seats', async () => {
    // 3-seat plan, 1 member + 2 links already out = full.
    mocks.state.memberCount = 1;
    mocks.state.pendingCount = 2;

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe('plan_limit_reached');
    expect(json.metric).toBe('operators');
    expect(json.limit).toBe(3);
    expect(json.used).toBe(3);
    expect(json.upgradeUrl).toBe('/billing');
    // Nothing was written: the link does not exist.
    expect(mocks.state.inserted).toBeNull();
  });

  it('counts the seats of THIS account only (leak test)', async () => {
    await post();
    const counted = mocks.state.countedFilters.filter((c) => c.counting);
    expect(counted.length).toBeGreaterThanOrEqual(2);
    for (const c of counted) {
      expect(c.filters).toContainEqual(['account_id', 'acct-1']);
    }
    expect(mocks.getEntitlements).toHaveBeenCalledWith('acct-1');
  });

  it('fails closed when the headcount cannot be taken', async () => {
    mocks.state.memberError = { message: 'permission denied' };
    const res = await post();
    expect(res.status).toBe(500);
    // "We could not count" must never read as "zero seats used".
    expect(mocks.state.inserted).toBeNull();
  });

  it('never blocks on a plan with no operators cap', async () => {
    mocks.getEntitlements.mockResolvedValue(entitlements(null));
    mocks.state.memberCount = 5000;
    const res = await post();
    expect(res.status).toBe(201);
  });
});
