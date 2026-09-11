import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 + §5 — `numbers`, and the read-only gate on a route that
// resolves its account by hand instead of through `requireRole`.
//
// `whatsapp_config` still carries UNIQUE(account_id), so today the count
// is 0 or 1 and no plan can trip the cap. The check is written against
// the count rather than against that constraint so it keeps meaning
// something when f4.2 drops the UNIQUE and multi-number arrives.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  assertWritable: vi.fn(),
  state: {
    numberCount: 0,
    countError: null as { message: string } | null,
    claimedByOther: null as Record<string, unknown> | null,
    existing: null as Record<string, unknown> | null,
    counted: [] as { table: string; filters: [string, unknown][] }[],
    inserted: null as Record<string, unknown> | null,
    updated: null as Record<string, unknown> | null,
  },
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertWritable: mocks.assertWritable,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => String(v).replace(/^enc:/, ''),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  registerPhoneNumber: vi.fn(async () => ({ success: true })),
  subscribeWabaToApp: vi.fn(async () => ({ success: true })),
  verifyPhoneNumber: vi.fn(async () => ({ verified: true })),
}));

// The route builds its own service-role client with the raw supabase-js
// factory; this keeps it from reaching the network.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        maybeSingle: async () => ({
          data: mocks.state.claimedByOther,
          error: null,
        }),
      };
      return chain;
    },
  }),
}));

const supabase = {
  auth: {
    getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
  },
  from: (table: string) => {
    const entry = {
      table,
      counting: false,
      filters: [] as [string, unknown][],
    };
    const chain: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) {
          entry.counting = true;
          mocks.state.counted.push(entry);
        }
        return chain;
      },
      eq: (col: string, val: unknown) => {
        entry.filters.push([col, val]);
        return chain;
      },
      neq: (col: string, val: unknown) => {
        entry.filters.push([`neq:${col}`, val]);
        return chain;
      },
      insert: (row: Record<string, unknown>) => {
        mocks.state.inserted = row;
        return chain;
      },
      update: (row: Record<string, unknown>) => {
        mocks.state.updated = row;
        return chain;
      },
      maybeSingle: async () => {
        if (table === 'profiles') {
          return { data: { account_id: 'acct-1' }, error: null };
        }
        if (table === 'whatsapp_config') {
          return { data: mocks.state.existing, error: null };
        }
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) =>
        resolve({
          count: mocks.state.numberCount,
          error: mocks.state.countError,
          data: null,
        }),
    };
    return chain;
  },
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => supabase,
}));

import { AccountLockedError } from '@/lib/billing/enforce';
import { POST } from './route';

function entitlements(numbers: number | null) {
  return {
    planId: 'inicio',
    status: 'active',
    limits: { numbers },
    features: [],
    readOnly: false,
    trialEndsAt: null,
  };
}

function post(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('https://crm.example.com/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number_id: 'pn-new',
        waba_id: 'waba-1',
        access_token: 'tok',
        ...overrides,
      }),
    })
  );
}

beforeEach(() => {
  mocks.state.numberCount = 0;
  mocks.state.countError = null;
  mocks.state.claimedByOther = null;
  mocks.state.existing = null;
  mocks.state.counted = [];
  mocks.state.inserted = null;
  mocks.state.updated = null;
  mocks.assertWritable.mockReset();
  mocks.assertWritable.mockResolvedValue(entitlements(1));
});

describe('POST /api/whatsapp/config — numbers + read-only (fase 3 §4/§5)', () => {
  it('403s a read-only account before anything is written or registered', async () => {
    mocks.assertWritable.mockRejectedValue(new AccountLockedError('suspended'));

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.code).toBe('account_read_only');
    expect(json.upgradeUrl).toBe('/billing');
    expect(mocks.state.inserted).toBeNull();
    expect(mocks.state.updated).toBeNull();
  });

  it('402s when the plan has no room for another number', async () => {
    // A 1-number plan that already has a different number bound.
    mocks.state.numberCount = 1;

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe('plan_limit_reached');
    expect(json.metric).toBe('numbers');
    expect(json.limit).toBe(1);
    expect(json.upgradeUrl).toBe('/billing');
    expect(mocks.state.inserted).toBeNull();
  });

  it('excludes the number being saved from the count, so re-saving is an edit', async () => {
    await post();
    expect(mocks.state.counted).toHaveLength(1);
    const counted = mocks.state.counted[0];
    expect(counted.table).toBe('whatsapp_config');
    // Scoped to this account (leak test) and excluding the number the
    // request is about.
    expect(counted.filters).toContainEqual(['account_id', 'acct-1']);
    expect(counted.filters).toContainEqual(['neq:phone_number_id', 'pn-new']);
    expect(mocks.assertWritable).toHaveBeenCalledWith('acct-1');
  });

  it('fails closed when the number count cannot be taken', async () => {
    mocks.state.countError = { message: 'permission denied' };
    const res = await post();
    expect(res.status).toBe(500);
    expect(mocks.state.inserted).toBeNull();
  });
});
