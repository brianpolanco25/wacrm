import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    // p11.1: what `whatsapp_config` holds, for EVERY account — the mock
    // applies the `account_id` filter the route sends, so a missing
    // filter shows up as B's numbers leaking into A's banner.
    numbers: [] as Record<string, unknown>[],
    numbersError: null as { message: string } | null,
    numberFilters: [] as [string, unknown][],
    tables: [] as string[],
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
    from: (table: string) => {
      mocks.state.tables.push(table);
      if (table === 'whatsapp_config') {
        const filters: [string, unknown][] = [];
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            mocks.state.numberFilters.push([col, val]);
            return chain;
          },
          then: (resolve: (v: unknown) => unknown) =>
            resolve({
              data: mocks.state.numbersError
                ? null
                : mocks.state.numbers.filter((r) =>
                    filters.every(([c, v]) => r[c] === v)
                  ),
              error: mocks.state.numbersError,
            }),
        };
        return chain;
      }
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
  mocks.state.numbers = [];
  mocks.state.numbersError = null;
  mocks.state.numberFilters = [];
  mocks.state.tables = [];
  vi.unstubAllEnvs();
  // Platform mode on (R17 needs it); self-hosted is set per test.
  vi.stubEnv('META_APP_ID', 'app-123');
  vi.stubEnv('META_CONFIG_ID', 'cfg-456');
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
      'metaBilling',
      'metaPayment',
      'planId',
      'readOnly',
      'status',
      'trialEndsAt',
    ]);
  });
});

// ---------------------------------------------------------------------------
// p11.1 — the WABA payment method rides on this same response (R14–R19).
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function num(
  account_id: string,
  meta_payment_status: string | null,
  extra: Record<string, unknown> = {}
) {
  return {
    account_id,
    status: 'connected',
    provisioned_via: 'embedded_signup',
    meta_payment_status,
    ...extra,
  };
}

describe('GET /api/billing/status — metaPayment (p11.1)', () => {
  it('reads whatsapp_config of the caller only and never calls Meta (R14)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mocks.state.numbers = [num('acct-1', 'missing')];
    const res = await GET();
    const json = await res.json();
    expect(json.metaPayment).toEqual({ banner: 'missing', missingNumbers: 1 });
    expect(json.metaBilling).toBe('direct');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.state.numberFilters).toEqual([['account_id', 'acct-1']]);
  });

  it("A never sees B's missing number (R19, leak A↔B)", async () => {
    mocks.state.numbers = [num('acct-1', 'ok'), num('acct-2', 'missing')];
    const json = await (await GET()).json();
    expect(json.metaPayment).toEqual({ banner: null, missingNumbers: 0 });
    expect(mocks.state.numberFilters).toContainEqual(['account_id', 'acct-1']);
    expect(mocks.state.numberFilters).not.toContainEqual([
      'account_id',
      'acct-2',
    ]);
  });

  it('a managed account gets no banner even with a missing number (R18)', async () => {
    mocks.state.row = { ...mocks.state.row, meta_billing: 'managed' };
    mocks.state.numbers = [num('acct-1', 'missing')];
    const json = await (await GET()).json();
    expect(json.metaBilling).toBe('managed');
    expect(json.metaPayment).toEqual({ banner: null, missingNumbers: 0 });
    // Nothing to decide, so nothing is read.
    expect(mocks.state.tables).not.toContain('whatsapp_config');
  });

  it('no subscription row → direct', async () => {
    mocks.state.row = null;
    mocks.state.numbers = [num('acct-1', 'missing')];
    const json = await (await GET()).json();
    expect(json.metaBilling).toBe('direct');
    expect(json.metaPayment.banner).toBe('missing');
  });

  it('META_PAYMENT_CHECK_DISABLED=1 → banner null (R13)', async () => {
    vi.stubEnv('META_PAYMENT_CHECK_DISABLED', '1');
    mocks.state.numbers = [num('acct-1', 'missing')];
    const json = await (await GET()).json();
    expect(json.metaPayment).toEqual({ banner: null, missingNumbers: 0 });
  });

  it('platform mode + embedded number unknown → soft notice (R17)', async () => {
    mocks.state.numbers = [num('acct-1', 'unknown')];
    const json = await (await GET()).json();
    expect(json.metaPayment.banner).toBe('unknown');
  });

  it('self-hosted with a token lacking permission → no global notice (R17, A7)', async () => {
    vi.stubEnv('META_CONFIG_ID', '');
    mocks.state.numbers = [
      num('acct-1', 'unknown', { provisioned_via: 'manual' }),
    ];
    const json = await (await GET()).json();
    expect(json.metaPayment.banner).toBeNull();
  });

  it('a failed read of the numbers is "no banner", never a 500', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.state.numbersError = { message: 'boom' };
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.metaPayment).toEqual({ banner: null, missingNumbers: 0 });
    expect(json.readOnly).toBe(true);
    errorSpy.mockRestore();
  });
});
