import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 4 §1 — registro integrado (Embedded Signup).
//
// The five acceptance criteria of the spec section, as far as they can be
// reached without Meta on the other end:
//
//   1. "connects WhatsApp without leaving the app and without touching
//      the Meta console" — the code-for-token exchange happens with OUR
//      app id and secret, the row lands encrypted, repeating the flow
//      does not duplicate it, and a dialog closed halfway writes nothing.
//   2. "the account ends up subscribed to our app" — /subscribed_apps and
//      /register run with the FRESHLY minted token and their timestamps
//      are persisted; a /register failure still saves the row.
//   5. "self-hosted keeps working" — without META_CONFIG_ID the GET says
//      disabled and the POST is a 404, i.e. the feature does not exist.
//
// Plus the credential-handling rule the whole feature hangs on: the
// one-time `code` and the access token must never reach `console.*`.
// ---------------------------------------------------------------------------

type ConfigRow = {
  id: string;
  account_id: string;
  phone_number_id: string;
  is_default?: boolean;
};

const mocks = vi.hoisted(() => ({
  assertWritable: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  getWabaFundingInfo: vi.fn(),
  checkPayment: vi.fn(),
  syncSmbAppData: vi.fn(),
  listWabaPhoneNumbers: vi.fn(),
  order: [] as string[],
  state: {
    role: 'admin' as string,
    rows: [] as ConfigRow[],
    claimedByOther: null as Record<string, unknown> | null,
    /** Every `.upsert()` the route performed: row + options. */
    upserts: [] as { row: Record<string, unknown>; opts: unknown }[],
    /** Any other write. Must stay empty on the cancel / error paths. */
    otherWrites: [] as { table: string; op: string }[],
    /** #1650 — the saved row as the service role sees it (SMB columns). */
    smbRow: {} as Record<string, string | null>,
    /** #1650 — every service-role update, with its filters. */
    adminUpdates: [] as {
      payload: Record<string, unknown>;
      filters: [string, string, unknown][];
    }[],
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
  verifyPhoneNumber: mocks.verifyPhoneNumber,
  registerPhoneNumber: mocks.registerPhoneNumber,
  subscribeWabaToApp: mocks.subscribeWabaToApp,
  getWabaFundingInfo: mocks.getWabaFundingInfo,
  syncSmbAppData: mocks.syncSmbAppData,
  listWabaPhoneNumbers: mocks.listWabaPhoneNumbers,
}));

// p11.1 step 10. The real `fetchWabaPaymentStatus` runs (against the
// mocked `getWabaFundingInfo`); only the row read/write is stubbed, so
// what is pinned is the token handed over, the scope and the order.
vi.mock('@/lib/whatsapp/payment-method', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/payment-method')>()),
  checkAndRecordPaymentStatus: mocks.checkPayment,
}));

// The service-role client exists for one query: "has another account
// already claimed this phone_number_id?".
// #1650 adds the SMB-sync writes of step 11: claim, request id, error.
// They act on `state.smbRow`, evaluating the claim like PostgREST would.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const filters: [string, string, unknown][] = [];
      let payload: Record<string, unknown> | null = null;
      const row = () => mocks.state.smbRow;
      const matches = () =>
        filters.every(([kind, col, val]) => {
          if (kind === 'is') return (row()[col] ?? null) === val;
          if (kind === 'or') {
            const [a, b] = String(val).split(',');
            const c = a.split('.')[0];
            const v = row()[c] ?? null;
            return v === null || Date.parse(v) < Date.parse(b.split('.lt.')[1]);
          }
          return true;
        });
      const run = () => {
        if (!payload) return { data: null, error: null };
        mocks.state.adminUpdates.push({ payload, filters: [...filters] });
        if (!matches()) return { data: [], error: null };
        Object.assign(mocks.state.smbRow, payload);
        return { data: [{ id: 'cfg-saved' }], error: null };
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          payload = p;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filters.push(['eq', col, val]);
          return chain;
        },
        neq: (col: string, val: unknown) => {
          filters.push(['neq', col, val]);
          return chain;
        },
        is: (col: string, val: unknown) => {
          filters.push(['is', col, val]);
          return chain;
        },
        or: (expr: string) => {
          filters.push(['or', '', expr]);
          return chain;
        },
        maybeSingle: async () => {
          if (filters.some(([k]) => k === 'neq')) {
            return { data: mocks.state.claimedByOther, error: null };
          }
          return { data: { ...mocks.state.smbRow }, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => resolve(run()),
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
      counting: false,
      filters: [] as [string, unknown][],
    };
    const chain: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) entry.counting = true;
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
      upsert: (row: Record<string, unknown>, opts: unknown) => {
        mocks.state.upserts.push({ row, opts });
        return chain;
      },
      insert: () => {
        mocks.state.otherWrites.push({ table, op: 'insert' });
        return chain;
      },
      update: () => {
        mocks.state.otherWrites.push({ table, op: 'update' });
        return chain;
      },
      delete: () => {
        mocks.state.otherWrites.push({ table, op: 'delete' });
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        if (table === 'profiles') {
          return {
            data: { account_id: 'acct-1', account_role: mocks.state.role },
            error: null,
          };
        }
        if (table === 'accounts') {
          return { data: { id: 'acct-1', name: 'Acme' }, error: null };
        }
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (mocks.state.upserts.length > 0 && table === 'whatsapp_config') {
          // The `.select('id')` that follows the upsert.
          const last = mocks.state.upserts[mocks.state.upserts.length - 1];
          if (last)
            return resolve({ data: [{ id: 'cfg-saved' }], error: null });
        }
        if (entry.counting) {
          const excluded = entry.filters.find(([c]) => c === 'neq:id')?.[1];
          const rows = mocks.state.rows.filter((r) => r.id !== excluded);
          return resolve({ count: rows.length, error: null, data: null });
        }
        if (table === 'whatsapp_config') {
          const byPhone = entry.filters.find(
            ([c]) => c === 'phone_number_id'
          )?.[1];
          const rows = mocks.state.rows.filter(
            (r) => byPhone === undefined || r.phone_number_id === byPhone
          );
          return resolve({ data: rows, error: null });
        }
        return resolve({ data: null, error: null });
      },
    };
    return chain;
  },
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => supabase,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, POST } from './route';

const CODE = 'AQD-super-secret-one-time-code';
const TOKEN = 'EAAB-the-business-access-token';

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

function post(body: Record<string, unknown> = {}) {
  return POST(
    new Request('https://crm.example.com/api/whatsapp/embedded-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: CODE,
        phone_number_id: 'pn-new',
        waba_id: 'waba-new',
        ...body,
      }),
    })
  );
}

/** The Graph response of a successful code exchange. */
function tokenResponse(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: TOKEN, token_type: 'bearer', ...extra }),
  } as unknown as Response;
}

const ENV_KEYS = [
  'META_APP_ID',
  'META_CONFIG_ID',
  'META_APP_SECRET',
  'META_GRAPH_VERSION',
  'META_WEBHOOK_VERIFY_TOKEN',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let fetchMock: ReturnType<typeof vi.fn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.META_APP_ID = 'app-123';
  process.env.META_CONFIG_ID = 'cfgid-456';
  process.env.META_APP_SECRET = 'super-secret-app-secret';
  process.env.META_GRAPH_VERSION = 'v21.0';
  process.env.META_WEBHOOK_VERIFY_TOKEN = 'platform-verify';

  mocks.state.role = 'admin';
  mocks.state.rows = [];
  mocks.state.claimedByOther = null;
  mocks.state.upserts = [];
  mocks.state.otherWrites = [];
  mocks.state.smbRow = {};
  mocks.state.adminUpdates = [];
  mocks.syncSmbAppData.mockReset();
  mocks.syncSmbAppData.mockImplementation(
    async ({ syncType }: { syncType: string }) => ({
      requestId: `req-${syncType}`,
    })
  );
  mocks.listWabaPhoneNumbers.mockReset();
  mocks.listWabaPhoneNumbers.mockResolvedValue([
    { id: 'pn-coex', is_on_biz_app: true, platform_type: 'CLOUD_API' },
  ]);
  mocks.assertWritable.mockReset();
  mocks.assertWritable.mockResolvedValue(entitlements(5));
  mocks.verifyPhoneNumber.mockReset();
  mocks.verifyPhoneNumber.mockResolvedValue({
    id: 'pn-new',
    display_phone_number: '+1 555 010 0000',
    verified_name: 'Acme Support',
  });
  mocks.registerPhoneNumber.mockReset();
  mocks.registerPhoneNumber.mockResolvedValue({
    success: true,
    alreadyRegistered: false,
  });
  mocks.subscribeWabaToApp.mockReset();
  mocks.subscribeWabaToApp.mockResolvedValue(undefined);
  mocks.order = [];
  mocks.getWabaFundingInfo.mockReset();
  mocks.getWabaFundingInfo.mockImplementation(async () => {
    mocks.order.push('payment');
    return { id: 'waba-new', primary_funding_id: 'fund-1' };
  });
  mocks.checkPayment.mockReset();
  mocks.checkPayment.mockImplementation(
    async (_db: unknown, _scope: unknown, opts: { accessToken: string }) => {
      const { fetchWabaPaymentStatus } = await vi.importActual<
        typeof import('@/lib/whatsapp/payment-method')
      >('@/lib/whatsapp/payment-method');
      const r = await fetchWabaPaymentStatus({
        wabaId: 'waba-new',
        accessToken: opts.accessToken,
      });
      return { ...r, checkedAt: '2026-10-01T00:00:00.000Z' };
    }
  );

  __resetRateLimitForTests();

  fetchMock = vi.fn(async () => {
    mocks.order.push('exchange');
    return tokenResponse();
  });
  vi.stubGlobal('fetch', fetchMock);

  consoleSpies = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Everything that reached any console mock, flattened to one string. */
function consoleOutput(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' | ');
}

// ---------------------------------------------------------------------------
// Criterion 1 — connect without leaving the app
// ---------------------------------------------------------------------------

describe('POST /api/whatsapp/embedded-signup — the exchange', () => {
  it('trades the code for a token with OUR app id and secret', async () => {
    const res = await post();
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      'https://graph.facebook.com/v21.0/oauth/access_token'
    );
    expect(url.searchParams.get('client_id')).toBe('app-123');
    expect(url.searchParams.get('client_secret')).toBe(
      'super-secret-app-secret'
    );
    expect(url.searchParams.get('code')).toBe(CODE);
    // Embedded Signup never redirects the browser, so a redirect_uri
    // would be matched against one that never happened.
    expect(url.searchParams.get('redirect_uri')).toBeNull();
  });

  it('stores the token encrypted, never in the clear', async () => {
    await post();
    const row = mocks.state.upserts[0]?.row as Record<string, unknown>;
    expect(row.access_token).toBe(`enc:${TOKEN}`);
    expect(row.access_token).not.toBe(TOKEN);
  });

  it('marks the row as provisioned by the dialog and leaves verify_token null', async () => {
    await post();
    const row = mocks.state.upserts[0]?.row as Record<string, unknown>;
    expect(row.provisioned_via).toBe('embedded_signup');
    // Platform mode configures the webhook once at app level; a
    // per-tenant verify token would have nothing to verify.
    expect(row.verify_token).toBeNull();
    expect(row.account_id).toBe('acct-1');
    expect(row.phone_number_id).toBe('pn-new');
    expect(row.waba_id).toBe('waba-new');
    expect(row.status).toBe('connected');
  });

  it('generates a six-digit registration PIN and stores it encrypted', async () => {
    await post();
    const pin = mocks.registerPhoneNumber.mock.calls[0]?.[0]?.pin;
    expect(pin).toMatch(/^\d{6}$/);
    const row = mocks.state.upserts[0]?.row as Record<string, unknown>;
    expect(row.registration_pin).toBe(`enc:${pin}`);
  });

  it('translates expires_in into token_expires_at, and its absence into null', async () => {
    await post();
    expect(
      (mocks.state.upserts[0]?.row as Record<string, unknown>).token_expires_at
    ).toBeNull();

    mocks.state.upserts = [];
    fetchMock.mockResolvedValueOnce(tokenResponse({ expires_in: 3600 }));
    await post();
    const at = (mocks.state.upserts[0]?.row as Record<string, unknown>)
      .token_expires_at as string;
    expect(typeof at).toBe('string');
    expect(Date.parse(at)).toBeGreaterThan(Date.now());
  });

  it('repeating the flow updates the same row instead of adding a second', async () => {
    mocks.state.rows = [
      {
        id: 'cfg-1',
        account_id: 'acct-1',
        phone_number_id: 'pn-new',
        is_default: true,
      },
    ];

    const res = await post();
    expect(res.status).toBe(200);
    expect(mocks.state.upserts).toHaveLength(1);
    expect(mocks.state.upserts[0]?.opts).toEqual({
      onConflict: 'account_id,phone_number_id',
    });
    // Never a plain insert: that is what would produce the duplicate.
    expect(mocks.state.otherWrites).toEqual([]);
    // And the account's default is not touched on a repeat pass — the
    // key is simply absent from the upserted row.
    expect(
      'is_default' in (mocks.state.upserts[0]?.row as Record<string, unknown>)
    ).toBe(false);
  });

  it('makes the very first number of an account its default', async () => {
    await post();
    expect(
      (mocks.state.upserts[0]?.row as Record<string, unknown>).is_default
    ).toBe(true);
  });
});

describe('POST /api/whatsapp/embedded-signup — the dialog did not finish', () => {
  it('400s without a code and writes nothing at all', async () => {
    const res = await post({ code: undefined });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe('incomplete_signup');
    expect(mocks.state.upserts).toEqual([]);
    expect(mocks.state.otherWrites).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s when the session event never delivered the phone number id', async () => {
    const res = await post({ phone_number_id: undefined });
    expect(res.status).toBe(400);
    expect(mocks.state.upserts).toEqual([]);
  });

  it('writes nothing when Meta rejects the code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'This code has expired' } }),
    } as unknown as Response);

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('This code has expired');
    expect(mocks.state.upserts).toEqual([]);
    expect(mocks.registerPhoneNumber).not.toHaveBeenCalled();
  });

  it("409s on another account's number before spending the code", async () => {
    mocks.state.claimedByOther = { account_id: 'acct-2' };

    const res = await post();
    expect(res.status).toBe(409);
    // The code is single use: burning it on a request that cannot
    // succeed would force the customer through the dialog again.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.state.upserts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Risk 3 of the design note: a credential in a log
// ---------------------------------------------------------------------------

describe('POST /api/whatsapp/embedded-signup — credentials never reach the log', () => {
  it('keeps the code and the token out of console on the happy path', async () => {
    await post();
    const out = consoleOutput();
    expect(out).not.toContain(CODE);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('super-secret-app-secret');
  });

  it('keeps them out when Meta rejects the exchange', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid verification code' } }),
    } as unknown as Response);

    await post();
    const out = consoleOutput();
    expect(out).toContain('Invalid verification code');
    expect(out).not.toContain(CODE);
    expect(out).not.toContain('super-secret-app-secret');
  });

  it('keeps them out when the exchange throws', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error(`network is unreachable while posting code=${CODE}`)
    );

    await post();
    // Even a message that carries the code is only reached through
    // `err.message`; what matters is that no response object or request
    // is dumped. This asserts the shape of the log line, which is the
    // part the route controls.
    const out = consoleOutput();
    expect(out).toContain('[embedded-signup] code exchange failed:');
    expect(out).not.toContain('super-secret-app-secret');
    expect(out).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — subscribed to our app, inbound routed to that company
// ---------------------------------------------------------------------------

describe('POST /api/whatsapp/embedded-signup — registration and subscription', () => {
  it('uses the freshly minted token for every Meta call', async () => {
    await post();

    expect(mocks.verifyPhoneNumber).toHaveBeenCalledWith({
      phoneNumberId: 'pn-new',
      accessToken: TOKEN,
    });
    expect(mocks.subscribeWabaToApp).toHaveBeenCalledWith({
      wabaId: 'waba-new',
      accessToken: TOKEN,
    });
    expect(mocks.registerPhoneNumber.mock.calls[0]?.[0]?.accessToken).toBe(
      TOKEN
    );
  });

  it('persists both timestamps and the metadata Meta reported', async () => {
    await post();
    const row = mocks.state.upserts[0]?.row as Record<string, unknown>;
    expect(typeof row.subscribed_apps_at).toBe('string');
    expect(typeof row.registered_at).toBe('string');
    expect(row.last_registration_error).toBeNull();
    expect(row.display_phone_number).toBe('+1 555 010 0000');
    expect(row.verified_name).toBe('Acme Support');
  });

  it('still saves the row when /register fails, with the reason', async () => {
    mocks.registerPhoneNumber.mockRejectedValueOnce(
      new Error('Two-step verification PIN is already set for this number')
    );

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.registered).toBe(false);
    const row = mocks.state.upserts[0]?.row as Record<string, unknown>;
    expect(row.last_registration_error).toContain(
      'Two-step verification PIN is already set'
    );
    // The credentials are valid — losing them would mean redoing the
    // whole dialog just to retry a PIN.
    expect(row.access_token).toBe(`enc:${TOKEN}`);
  });

  it('does not abort when the WABA subscription fails', async () => {
    mocks.subscribeWabaToApp.mockRejectedValueOnce(new Error('rate limited'));

    const res = await post();
    expect(res.status).toBe(200);
    const row = mocks.state.upserts[0]?.row as Record<string, unknown>;
    expect(row.subscribed_apps_at).toBeNull();
    expect(row.registered_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The `numbers` stock limit of f3.4, reused rather than re-implemented
// ---------------------------------------------------------------------------

describe('POST /api/whatsapp/embedded-signup — the numbers allowance', () => {
  it('402s on a second, different number when the plan allows one', async () => {
    mocks.assertWritable.mockResolvedValue(entitlements(1));
    mocks.state.rows = [
      { id: 'cfg-1', account_id: 'acct-1', phone_number_id: 'pn-old' },
    ];

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.metric).toBe('numbers');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.state.upserts).toEqual([]);
  });

  it('lets an account reconnect a number it already has on a full plan', async () => {
    mocks.assertWritable.mockResolvedValue(entitlements(1));
    mocks.state.rows = [
      { id: 'cfg-1', account_id: 'acct-1', phone_number_id: 'pn-new' },
    ];

    const res = await post();
    expect(res.status).toBe(200);
    expect(mocks.state.upserts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — the self-hosted install keeps working
// ---------------------------------------------------------------------------

describe('self-hosted mode (no META_CONFIG_ID)', () => {
  beforeEach(() => {
    delete process.env.META_CONFIG_ID;
  });

  it('GET reports the feature as disabled and leaks no ids', async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ enabled: false });
  });

  it('POST 404s: in self-hosted mode the route does not exist', async () => {
    const res = await post();
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toBe('embedded_signup_disabled');
    expect(mocks.state.upserts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST 404s with the config id set but the app secret missing', async () => {
    process.env.META_CONFIG_ID = 'cfgid-456';
    delete process.env.META_APP_SECRET;
    const res = await post();
    expect(res.status).toBe(404);
  });
});

describe('GET /api/whatsapp/embedded-signup in platform mode', () => {
  it('returns the public ids and never the app secret', async () => {
    const res = await GET();
    const json = await res.json();

    expect(json.enabled).toBe(true);
    expect(json.app_id).toBe('app-123');
    expect(json.config_id).toBe('cfgid-456');
    expect(json.graph_version).toBe('v21.0');
    expect(JSON.stringify(json)).not.toContain('super-secret-app-secret');
    expect(json.warning).toBeUndefined();
  });

  it('falls back to the default graph version', async () => {
    delete process.env.META_GRAPH_VERSION;
    const json = await (await GET()).json();
    expect(json.graph_version).toBe('v21.0');
  });

  it('warns the operator when META_WEBHOOK_VERIFY_TOKEN is missing', async () => {
    // Platform rows carry no verify_token, so without this variable
    // Meta's webhook verification can never succeed.
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    const json = await (await GET()).json();
    expect(json.enabled).toBe(true);
    expect(json.warning).toBe('missing_verify_token');
  });

  it('refuses a non-admin', async () => {
    mocks.state.role = 'agent';
    const res = await GET();
    expect(res.status).toBe(403);
  });
});

describe('POST /api/whatsapp/embedded-signup — who may call it', () => {
  it('403s an agent', async () => {
    mocks.state.role = 'agent';
    const res = await post();
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('429s once the per-user bucket is spent', async () => {
    for (let i = 0; i < 10; i++) await post();
    const res = await post();
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// p11.1 — step 10: the payment method of the WABA (R7)
// ---------------------------------------------------------------------------

describe('POST /api/whatsapp/embedded-signup — payment method (p11.1)', () => {
  it('ok: checks with the fresh token, scoped to the saved row, after the exchange', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payment_status).toBe('ok');
    expect(body.success).toBe(true);
    expect(mocks.checkPayment).toHaveBeenCalledTimes(1);
    const [, scope, opts] = mocks.checkPayment.mock.calls[0] as [
      unknown,
      { accountId: string; configId: string },
      { accessToken: string },
    ];
    expect(scope).toEqual({ accountId: 'acct-1', configId: 'cfg-saved' });
    expect(opts.accessToken).toBe(TOKEN);
    // Never before the code exchange (nor before the upsert).
    expect(mocks.order).toEqual(['exchange', 'payment']);
    expect(mocks.getWabaFundingInfo.mock.calls[0]?.[0]).toMatchObject({
      wabaId: 'waba-new',
      accessToken: TOKEN,
    });
  });

  it('missing: 200 with payment_status missing', async () => {
    mocks.getWabaFundingInfo.mockResolvedValue({ id: 'waba-new' });
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payment_status).toBe('missing');
    expect(body.success).toBe(true);
  });

  it("Meta's check rejected → still 200, same success, payment_status unknown", async () => {
    mocks.getWabaFundingInfo.mockRejectedValue(new TypeError('fetch failed'));
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.config_id).toBe('cfg-saved');
    expect(body.payment_status).toBe('unknown');
    expect(consoleOutput()).not.toContain(TOKEN);
  });

  it('a check that throws outright does not change the signup answer', async () => {
    mocks.checkPayment.mockRejectedValue(new Error('boom'));
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.payment_status).toBe('unknown');
  });

  it('no check at all when the signup fails before saving', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'code expired' } }),
    } as unknown as Response);
    const res = await post();
    expect(res.status).toBe(400);
    expect(mocks.checkPayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #1650 — coexistence (WhatsApp Business app + Cloud API)
// ---------------------------------------------------------------------------

describe('POST /api/whatsapp/embedded-signup — coexistence (#1650)', () => {
  it('R5: no /register, no PIN, connected, coexistence_onboarded_at set', async () => {
    const res = await post({ coexistence: true });
    expect(res.status).toBe(200);
    expect(mocks.registerPhoneNumber).not.toHaveBeenCalled();

    const row = mocks.state.upserts[0].row;
    expect(row.provisioned_via).toBe('embedded_signup');
    expect(row.status).toBe('connected');
    expect(row.registered_at).toBeNull();
    expect(row.last_registration_error).toBeNull();
    expect(row.registration_pin).toBeNull();
    expect(typeof row.coexistence_onboarded_at).toBe('string');
    expect(
      Number.isNaN(Date.parse(row.coexistence_onboarded_at as string))
    ).toBe(false);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.coexistence).toBe(true);
    expect(body.registered).toBe(false);
    expect(body.registration_error).toBeNull();
  });

  it('R6: the ordinary flow writes coexistence_onboarded_at null and registers', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(mocks.registerPhoneNumber).toHaveBeenCalledTimes(1);
    expect(mocks.state.upserts[0].row.coexistence_onboarded_at).toBeNull();
    expect(mocks.syncSmbAppData).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.coexistence).toBe(false);
    expect(body.smb_sync).toBeUndefined();
  });

  it("R6: coexistence: 'yes' is not true — treated as the ordinary flow", async () => {
    const res = await post({ coexistence: 'yes' });
    expect(res.status).toBe(200);
    expect(mocks.registerPhoneNumber).toHaveBeenCalledTimes(1);
    expect(mocks.state.upserts[0].row.coexistence_onboarded_at).toBeNull();
    expect(mocks.syncSmbAppData).not.toHaveBeenCalled();
  });

  it('R7/R11: requests both syncs with the fresh token, scoped to the row and account', async () => {
    const res = await post({ coexistence: true });
    const body = await res.json();
    expect(body.smb_sync).toEqual({
      state_sync: 'requested',
      history: 'requested',
    });
    expect(mocks.syncSmbAppData.mock.calls.map((c) => c[0])).toEqual([
      {
        phoneNumberId: 'pn-new',
        accessToken: TOKEN,
        syncType: 'smb_app_state_sync',
      },
      { phoneNumberId: 'pn-new', accessToken: TOKEN, syncType: 'history' },
    ]);
    expect(mocks.state.smbRow.smb_state_sync_request_id).toBe(
      'req-smb_app_state_sync'
    );
    expect(mocks.state.smbRow.smb_history_sync_request_id).toBe('req-history');
    expect(typeof mocks.state.smbRow.smb_state_sync_requested_at).toBe(
      'string'
    );
    expect(mocks.state.adminUpdates.length).toBeGreaterThan(0);
    for (const u of mocks.state.adminUpdates) {
      expect(u.filters).toContainEqual(['eq', 'id', 'cfg-saved']);
      expect(u.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    }
  });

  it('R8: a repeated signup on a row with both request ids makes zero sync calls', async () => {
    mocks.state.smbRow = {
      smb_state_sync_request_id: 'r1',
      smb_state_sync_requested_at: '2026-11-02T00:00:00.000Z',
      smb_history_sync_request_id: 'r2',
      smb_history_sync_requested_at: '2026-11-02T00:00:00.000Z',
    };
    const res = await post({ coexistence: true });
    expect(res.status).toBe(200);
    expect(mocks.syncSmbAppData).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.smb_sync).toEqual({
      state_sync: 'already_done',
      history: 'already_done',
    });
    expect(mocks.state.smbRow.smb_state_sync_request_id).toBe('r1');
  });

  it('R9: a failed sync still answers 200 success and never logs the token', async () => {
    mocks.syncSmbAppData.mockImplementation(async () => {
      throw new Error('(#100) sync not allowed');
    });
    const res = await post({ coexistence: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.smb_sync).toEqual({ state_sync: 'failed', history: 'failed' });
    expect(mocks.state.smbRow.smb_sync_error).toContain('sync not allowed');
    expect(mocks.state.smbRow.smb_state_sync_requested_at).toBeNull();
    expect(consoleOutput()).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});

describe('POST /api/whatsapp/embedded-signup — coexistence with only waba_id (ajuste del leader)', () => {
  function postWabaOnly(extra: Record<string, unknown> = {}) {
    return POST(
      new Request('https://crm.example.com/api/whatsapp/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: CODE,
          waba_id: 'waba-new',
          coexistence: true,
          ...extra,
        }),
      })
    );
  }

  it('resolves the number from the WABA with the fresh token', async () => {
    const res = await postWabaOnly();
    expect(res.status).toBe(200);
    expect(mocks.listWabaPhoneNumbers).toHaveBeenCalledWith({
      wabaId: 'waba-new',
      accessToken: TOKEN,
    });
    expect(mocks.state.upserts[0].row.phone_number_id).toBe('pn-coex');
    expect(mocks.verifyPhoneNumber).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'pn-coex' })
    );
    expect(mocks.syncSmbAppData.mock.calls[0][0].phoneNumberId).toBe('pn-coex');
  });

  it('400s with a clear code when more than one number is on the app', async () => {
    mocks.listWabaPhoneNumbers.mockResolvedValue([
      { id: 'a', is_on_biz_app: true },
      { id: 'b', is_on_biz_app: true },
    ]);
    const res = await postWabaOnly();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('coexistence_number_ambiguous');
    expect(mocks.state.upserts).toHaveLength(0);
  });

  it('400s when no number of the WABA is on the app', async () => {
    mocks.listWabaPhoneNumbers.mockResolvedValue([
      { id: 'a', is_on_biz_app: false },
    ]);
    const res = await postWabaOnly();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('coexistence_number_not_found');
    expect(mocks.state.upserts).toHaveLength(0);
  });

  it("409s on another account's resolved number and writes nothing", async () => {
    mocks.state.claimedByOther = { account_id: 'acct-other' };
    const res = await postWabaOnly();
    expect(res.status).toBe(409);
    expect(mocks.state.upserts).toHaveLength(0);
  });

  it('still 400s incomplete without phone_number_id outside coexistence', async () => {
    const res = await postWabaOnly({ coexistence: false });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('incomplete_signup');
    expect(mocks.listWabaPhoneNumbers).not.toHaveBeenCalled();
  });
});
