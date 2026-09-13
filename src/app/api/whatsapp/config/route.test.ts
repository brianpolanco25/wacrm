import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 + §5 — `numbers`, and the read-only gate on a route that
// resolves its account by hand instead of through `requireRole`.
//
// The subtlety the first cut got wrong: a save adds ONE number, so the
// rows to count are every OTHER row of the account — excluded by row
// identity, not by `phone_number_id`. `whatsapp_config` still carries
// UNIQUE(account_id), so the account's single row holds the OLD number
// and excluding by number counted it: changing the number (the Meta test
// number the onboarding starts with, then the production one) answered
// 402 on every plan with `numbers: 1`, which is two of the three.
//
// Consequence of that same UNIQUE: with the count excluding the edited
// row it is always 0 today, so the multi-row cap is UNREACHABLE until
// f4.2 drops the constraint. It is not faked here — the 402 is exercised
// through the one shape that IS reachable, a plan whose `numbers` cap
// leaves no room for a first number.
// ---------------------------------------------------------------------------

type ConfigRow = {
  id: string;
  phone_number_id: string;
  registered_at: string | null;
  is_default?: boolean;
};

const mocks = vi.hoisted(() => ({
  assertWritable: vi.fn(),
  state: {
    /** The account's `whatsapp_config` rows. One at most, for now. */
    rows: [] as ConfigRow[],
    countError: null as { message: string } | null,
    existingError: null as { message: string } | null,
    claimedByOther: null as Record<string, unknown> | null,
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
      writing: false,
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
        entry.writing = true;
        mocks.state.inserted = row;
        return chain;
      },
      update: (row: Record<string, unknown>) => {
        entry.writing = true;
        mocks.state.updated = row;
        return chain;
      },
      delete: () => {
        entry.writing = true;
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        if (table === 'profiles') {
          return { data: { account_id: 'acct-1' }, error: null };
        }
        if (table === 'whatsapp_config') {
          if (mocks.state.existingError) {
            return { data: null, error: mocks.state.existingError };
          }
          return { data: mocks.state.rows[0] ?? null, error: null };
        }
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (!entry.counting) {
          if (entry.writing) {
            // A write (update/insert/delete): resolves with no error.
            return resolve({ data: [{ id: 'cfg-new' }], error: null });
          }
          if (table === 'whatsapp_config') {
            // The "which row does this save overwrite?" lookup. Post-053
            // it is a plain list query — `.maybeSingle()` would error the
            // moment the account has two numbers — so it has to honour
            // the filters the route applied (`id` or `phone_number_id`).
            if (mocks.state.existingError) {
              return resolve({ data: null, error: mocks.state.existingError });
            }
            const byId = entry.filters.find(([c]) => c === 'id')?.[1];
            const byPhone = entry.filters.find(
              ([c]) => c === 'phone_number_id'
            )?.[1];
            const rows = mocks.state.rows.filter(
              (r) =>
                (byId === undefined || r.id === byId) &&
                (byPhone === undefined || r.phone_number_id === byPhone)
            );
            return resolve({ data: rows, error: null });
          }
          return resolve({ data: null, error: null });
        }
        // The real count honours the filters, so excluding the edited
        // row by id has to actually shrink the answer — otherwise the
        // test would pass with the broken `.neq('phone_number_id', …)`
        // just as happily.
        const excludedId = entry.filters.find(([c]) => c === 'neq:id')?.[1];
        const rows = mocks.state.rows.filter((r) => r.id !== excludedId);
        return resolve({
          count: rows.length,
          error: mocks.state.countError,
          data: null,
        });
      },
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
  mocks.state.rows = [];
  mocks.state.countError = null;
  mocks.state.existingError = null;
  mocks.state.claimedByOther = null;
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

  it('lets a 1-number plan swap its number: editing the row is not a second number', async () => {
    // The onboarding path: the account saved Meta's test number first
    // and now saves the production one. Same row, `numbers: 1`. Post-053
    // the row is named explicitly with `config_id` — without it, saving
    // a DIFFERENT number is by definition a second number (next test).
    mocks.state.rows = [
      { id: 'cfg-1', phone_number_id: 'pn-old', registered_at: null },
    ];

    const res = await post({ phone_number_id: 'pn-prod', config_id: 'cfg-1' });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.saved).toBe(true);
    // It updated the existing row rather than adding one…
    expect(mocks.state.updated).toMatchObject({ phone_number_id: 'pn-prod' });
    expect(mocks.state.inserted).toBeNull();
    // …and the count that fed the cap excluded that row BY ID.
    expect(mocks.state.counted).toHaveLength(1);
    expect(mocks.state.counted[0].filters).toContainEqual(['neq:id', 'cfg-1']);
  });

  // ---- fase 4 §1 / plan §7: the cap is real now that 053 dropped
  // UNIQUE(account_id). Two shapes, and the difference between them is
  // the whole point: re-saving a number you already have is an edit and
  // costs nothing; a second, different number is what the plan sells.
  it('a 1-number plan can re-save the number it already has', async () => {
    mocks.state.rows = [
      { id: 'cfg-1', phone_number_id: 'pn-a', registered_at: null },
    ];

    const res = await post({ phone_number_id: 'pn-a' });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.saved).toBe(true);
    // Matched by number, with no id in the body: still an edit.
    expect(mocks.state.updated).toMatchObject({ phone_number_id: 'pn-a' });
    expect(mocks.state.inserted).toBeNull();
    expect(mocks.state.counted[0].filters).toContainEqual(['neq:id', 'cfg-1']);
  });

  it('402s the same account on a SECOND, different number', async () => {
    mocks.state.rows = [
      { id: 'cfg-1', phone_number_id: 'pn-a', registered_at: null },
    ];

    const res = await post({ phone_number_id: 'pn-b' });
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe('plan_limit_reached');
    expect(json.metric).toBe('numbers');
    expect(json.limit).toBe(1);
    expect(json.used).toBe(1);
    expect(json.upgradeUrl).toBe('/billing');
    expect(mocks.state.inserted).toBeNull();
    expect(mocks.state.updated).toBeNull();
  });

  it('404s a config_id that is not one of the account rows', async () => {
    // CP3: an id from another account resolves to nothing here, and
    // "nothing" must read as not-found rather than as "create a row".
    mocks.state.rows = [
      { id: 'cfg-1', phone_number_id: 'pn-a', registered_at: null },
    ];

    const res = await post({ phone_number_id: 'pn-a', config_id: 'cfg-of-b' });

    expect(res.status).toBe(404);
    expect(mocks.state.inserted).toBeNull();
    expect(mocks.state.updated).toBeNull();
  });

  it('402s when the plan leaves no room for the number being saved', async () => {
    // Reachable shape today: a plan whose `numbers` cap is 0. The
    // multi-row cap (2 rows against `numbers: 1`) cannot happen while
    // `whatsapp_config` keeps UNIQUE(account_id); f4.2 drops it and this
    // is the check that will catch it then.
    mocks.assertWritable.mockResolvedValue(entitlements(0));

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe('plan_limit_reached');
    expect(json.metric).toBe('numbers');
    expect(json.limit).toBe(0);
    expect(json.upgradeUrl).toBe('/billing');
    expect(mocks.state.inserted).toBeNull();
    expect(mocks.state.updated).toBeNull();
  });

  it('counts only this account, and asks the gate for this account (leak test)', async () => {
    await post();

    expect(mocks.state.counted).toHaveLength(1);
    const counted = mocks.state.counted[0];
    expect(counted.table).toBe('whatsapp_config');
    expect(counted.filters).toContainEqual(['account_id', 'acct-1']);
    // A first save has no row to exclude, and the number itself is
    // never what the exclusion keys on.
    expect(counted.filters.map(([c]) => c)).not.toContain(
      'neq:phone_number_id'
    );
    expect(mocks.assertWritable).toHaveBeenCalledWith('acct-1');
  });

  it('fails closed when the number count cannot be taken', async () => {
    mocks.state.countError = { message: 'permission denied' };
    const res = await post();
    expect(res.status).toBe(500);
    expect(mocks.state.inserted).toBeNull();
  });

  it('fails closed when the existing row cannot be read', async () => {
    // Not knowing whether a row exists is not knowing whether this save
    // is an edit — refuse rather than guess in the customer's favour.
    mocks.state.existingError = { message: 'permission denied' };
    const res = await post();
    expect(res.status).toBe(500);
    expect(mocks.state.inserted).toBeNull();
    expect(mocks.state.updated).toBeNull();
  });
});
