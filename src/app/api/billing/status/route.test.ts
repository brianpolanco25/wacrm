import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// GET /api/billing/status — what the dunning banner of fase 3 §5 reads.
//
// It must answer the same `readOnly` the server enforces with (so the
// banner cannot disagree with the 403s), must be open to a `viewer` (who
// is exactly the person staring at an app that refuses to save), and
// must never read another account's row.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  getEntitlements: vi.fn(),
  state: {
    row: null as Record<string, unknown> | null,
    error: null as { message: string } | null,
    filters: [] as [string, unknown][],
  },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  getEntitlements: mocks.getEntitlements,
}));

import { GET } from './route';

function supabaseMock() {
  return {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          mocks.state.filters.push([col, val]);
          return chain;
        },
        maybeSingle: async () => ({
          data: mocks.state.row,
          error: mocks.state.error,
        }),
      };
      return chain;
    },
  };
}

beforeEach(() => {
  mocks.state.row = {
    grace_until: '2026-09-20T00:00:00Z',
    trial_ends_at: null,
    current_period_end: '2026-10-01T00:00:00Z',
    cancel_at_period_end: false,
  };
  mocks.state.error = null;
  mocks.state.filters = [];
  mocks.getCurrentAccount.mockReset();
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: supabaseMock(),
    accountId: 'acct-1',
    userId: 'user-1',
    // A viewer: the least-privileged member still gets an answer.
    role: 'viewer',
    account: { id: 'acct-1', name: 'Acme' },
  });
  mocks.getEntitlements.mockReset();
  mocks.getEntitlements.mockResolvedValue({
    planId: 'pro',
    status: 'suspended',
    limits: {},
    features: [],
    readOnly: true,
    trialEndsAt: null,
  });
});

describe('GET /api/billing/status (fase 3 §5)', () => {
  it('reports the same readOnly the enforcement layer uses', async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.readOnly).toBe(true);
    expect(json.status).toBe('suspended');
    expect(json.planId).toBe('pro');
    expect(json.graceUntil).toBe('2026-09-20T00:00:00Z');
  });

  it('answers a viewer — the member most likely to be confused', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it('reads the caller account and no other (leak test)', async () => {
    await GET();
    expect(mocks.state.filters).toContainEqual(['account_id', 'acct-1']);
    expect(mocks.getEntitlements).toHaveBeenCalledWith('acct-1');
  });

  it('still answers when the account has no subscription row yet', async () => {
    mocks.state.row = null;
    mocks.getEntitlements.mockResolvedValue({
      planId: 'pro',
      status: 'trialing',
      limits: {},
      features: [],
      readOnly: false,
      trialEndsAt: null,
    });
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('trialing');
    expect(json.readOnly).toBe(false);
    expect(json.graceUntil).toBeNull();
    expect(json.cancelAtPeriodEnd).toBe(false);
  });

  it('500s rather than guessing when the subscription cannot be read', async () => {
    mocks.state.error = { message: 'permission denied' };
    const res = await GET();
    expect(res.status).toBe(500);
  });

  it('never returns provider ids or money figures', async () => {
    const res = await GET();
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual([
      'cancelAtPeriodEnd',
      'currentPeriodEnd',
      'graceUntil',
      'planId',
      'readOnly',
      'status',
      'trialEndsAt',
    ]);
  });
});
