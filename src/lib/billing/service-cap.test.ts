import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SERVICE_FREE_TIER_PER_NUMBER,
  asServiceCapAction,
  serviceMonthWindow,
  serviceCapState,
  loadServiceUsage,
  isAiPausedByServiceCap,
} from './service-cap';

// ------------------------------------------------------------
// Base falsa con varias cuentas, para que una fuga entre cuentas se vea
// como un resultado distinto y no como un filtro ausente.
// ------------------------------------------------------------
interface Db {
  accounts: Array<Record<string, unknown>>;
  subscriptions: Array<Record<string, unknown>>;
  whatsapp_config: Array<Record<string, unknown>>;
  /** Filas que devolvería `service_quota_usage`, por cuenta. */
  usage: Record<string, Array<Record<string, unknown>>>;
  errors: Partial<Record<string, { message: string }>>;
  rpcThrows: boolean;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  tablesRead: string[];
}

let db: Db;

function makeClient(): SupabaseClient {
  const from = (table: string) => {
    db.tablesRead.push(table);
    const filters: Array<[string, unknown]> = [];
    let order: Array<[string, boolean]> = [];
    let limit: number | null = null;
    const rows = () => {
      let r = (db as unknown as Record<string, unknown>)[table] as
        Array<Record<string, unknown>> | undefined;
      r = (r ?? []).filter((row) => filters.every(([c, v]) => row[c] === v));
      for (const [col, asc] of [...order].reverse()) {
        r = [...r].sort((a, b) => {
          const av = a[col] as string | boolean;
          const bv = b[col] as string | boolean;
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (asc ? 1 : -1);
        });
      }
      return limit === null ? r : r.slice(0, limit);
    };
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return chain;
      },
      order: (c: string, o?: { ascending?: boolean }) => {
        order = [...order, [c, o?.ascending !== false]];
        return chain;
      },
      limit: (n: number) => {
        limit = n;
        return Promise.resolve({ data: rows(), error: null });
      },
      maybeSingle: () => {
        const err = db.errors[table];
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
    };
    return chain;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    db.rpcCalls.push({ name, args });
    if (db.rpcThrows) throw new Error('network down');
    if (db.errors.rpc) {
      return Promise.resolve({ data: null, error: db.errors.rpc });
    }
    return Promise.resolve({
      data: db.usage[args.p_account_id as string] ?? [],
      error: null,
    });
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const NOW = new Date('2026-10-15T12:00:00Z');

beforeEach(() => {
  db = {
    accounts: [
      { id: 'acct-A', service_cap_action: 'pause_ai' },
      { id: 'acct-B', service_cap_action: 'pause_ai' },
    ],
    subscriptions: [
      { account_id: 'acct-A', meta_billing: 'direct' },
      { account_id: 'acct-B', meta_billing: 'direct' },
    ],
    whatsapp_config: [
      {
        id: 'cfg-A1',
        account_id: 'acct-A',
        is_default: true,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'cfg-A2',
        account_id: 'acct-A',
        is_default: false,
        created_at: '2026-02-01T00:00:00Z',
      },
      {
        id: 'cfg-B1',
        account_id: 'acct-B',
        is_default: true,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    usage: {},
    errors: {},
    rpcThrows: false,
    rpcCalls: [],
    tablesRead: [],
  };
});

describe('serviceCapState (R4)', () => {
  it('999 used and nothing billable is not exhausted', () => {
    expect(serviceCapState({ used: 999, billable: 0 })).toEqual({
      used: 999,
      billable: 0,
      exhausted: false,
    });
  });
  it('1000 used is exhausted', () => {
    expect(serviceCapState({ used: 1000, billable: 0 }).exhausted).toBe(true);
  });
  it('any billable service message is exhausted even with a low count', () => {
    expect(serviceCapState({ used: 10, billable: 1 }).exhausted).toBe(true);
  });
  it('no row means 0 used and not exhausted', () => {
    expect(serviceCapState(undefined)).toEqual({
      used: 0,
      billable: 0,
      exhausted: false,
    });
  });
  it('the free tier is 1000 per number (S-C1)', () => {
    expect(SERVICE_FREE_TIER_PER_NUMBER).toBe(1000);
  });
});

describe('asServiceCapAction', () => {
  it('only pause_ai is pause_ai; anything else is warn', () => {
    expect(asServiceCapAction('pause_ai')).toBe('pause_ai');
    expect(asServiceCapAction('warn')).toBe('warn');
    expect(asServiceCapAction('foo')).toBe('warn');
    expect(asServiceCapAction(null)).toBe('warn');
    expect(asServiceCapAction(undefined)).toBe('warn');
  });
});

describe('serviceMonthWindow (R4, S-C4)', () => {
  it('31 Dec 23:59 UTC resets on 1 Jan of the next year', () => {
    const w = serviceMonthWindow(new Date('2026-12-31T23:59:00Z'));
    expect(w.monthStart.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(w.resetsAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
  it('29 Feb of a leap year belongs to February', () => {
    const w = serviceMonthWindow(new Date('2028-02-29T10:00:00Z'));
    expect(w.monthStart.toISOString()).toBe('2028-02-01T00:00:00.000Z');
    expect(w.resetsAt.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });
  it('uses UTC, not the local clock: 1 Oct 02:00 UTC is October', () => {
    const w = serviceMonthWindow(new Date('2026-10-01T02:00:00Z'));
    expect(w.monthStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('loadServiceUsage', () => {
  it('calls the RPC with the account and the month start, and maps rows', async () => {
    db.usage['acct-A'] = [
      { whatsapp_config_id: 'cfg-A1', used: 1000, billable: 0 },
      { whatsapp_config_id: 'cfg-A2', used: '12', billable: '0' },
    ];
    const map = await loadServiceUsage(makeClient(), 'acct-A', NOW);
    expect(db.rpcCalls).toEqual([
      {
        name: 'service_quota_usage',
        args: {
          p_account_id: 'acct-A',
          p_since: '2026-10-01T00:00:00.000Z',
        },
      },
    ]);
    expect(map.get('cfg-A1')?.exhausted).toBe(true);
    expect(map.get('cfg-A2')).toEqual({
      used: 12,
      billable: 0,
      exhausted: false,
    });
  });
  it('throws when the RPC resolves with an error', async () => {
    db.errors.rpc = { message: 'permission denied' };
    await expect(loadServiceUsage(makeClient(), 'acct-A', NOW)).rejects.toThrow(
      /service_quota_usage failed/
    );
  });
});

describe('isAiPausedByServiceCap (R9–R13)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const check = (
    sealedConfigId: string | null,
    accountId = 'acct-A',
    now = NOW
  ) =>
    isAiPausedByServiceCap(makeClient(), {
      accountId,
      conversationId: 'conv-1',
      sealedConfigId,
      now,
    });

  it('pauses when the sealed number is exhausted and the account chose pause_ai', async () => {
    db.usage['acct-A'] = [
      { whatsapp_config_id: 'cfg-A2', used: 1000, billable: 3 },
    ];
    expect(await check('cfg-A2')).toBe(true);
  });

  it('does not pause when a different number of the account is exhausted', async () => {
    db.usage['acct-A'] = [
      { whatsapp_config_id: 'cfg-A1', used: 1000, billable: 0 },
    ];
    expect(await check('cfg-A2')).toBe(false);
  });

  it('with no sealed number, falls back to the default number (R12)', async () => {
    db.usage['acct-A'] = [
      { whatsapp_config_id: 'cfg-A1', used: 1200, billable: 200 },
    ];
    expect(await check(null)).toBe(true);
  });

  it('with no default, falls back to the oldest number', async () => {
    db.whatsapp_config = db.whatsapp_config.map((c) => ({
      ...c,
      is_default: false,
    }));
    db.usage['acct-A'] = [
      { whatsapp_config_id: 'cfg-A1', used: 1000, billable: 0 },
    ];
    expect(await check(null)).toBe(true);
  });

  it("a sealed number of ANOTHER account never resolves (CP3): B's exhausted number does not pause A", async () => {
    db.usage['acct-B'] = [
      { whatsapp_config_id: 'cfg-B1', used: 5000, billable: 4000 },
    ];
    // A's default (cfg-A1) has nothing this month.
    expect(await check('cfg-B1')).toBe(false);
    // And the count was asked for A only.
    expect(db.rpcCalls.map((c) => c.args.p_account_id)).toEqual(['acct-A']);
  });

  it('a sealed id that no longer exists falls back to the default', async () => {
    db.usage['acct-A'] = [
      { whatsapp_config_id: 'cfg-A1', used: 1000, billable: 0 },
    ];
    expect(await check('cfg-gone')).toBe(true);
  });

  it('without any number, does not pause', async () => {
    db.whatsapp_config = [];
    expect(await check(null)).toBe(false);
    expect(db.rpcCalls).toEqual([]);
  });

  it('in warn, never pauses and never calls the RPC (R10)', async () => {
    db.accounts[0].service_cap_action = 'warn';
    db.usage['acct-A'] = [
      { whatsapp_config_id: 'cfg-A1', used: 5000, billable: 4000 },
    ];
    expect(await check('cfg-A1')).toBe(false);
    expect(db.rpcCalls).toEqual([]);
    expect(db.tablesRead).toEqual(['accounts']);
  });

  it('in a managed account, never pauses and never calls the RPC (R10, A6)', async () => {
    db.subscriptions[0].meta_billing = 'managed';
    db.usage['acct-A'] = [
      { whatsapp_config_id: 'cfg-A1', used: 5000, billable: 4000 },
    ];
    expect(await check('cfg-A1')).toBe(false);
    expect(db.rpcCalls).toEqual([]);
  });

  it('on the 1st at 00:00:01 UTC asks from the new month and, with no rows, does not pause (R13)', async () => {
    const rpcFor = (since: string) =>
      since === '2026-11-01T00:00:00.000Z'
        ? []
        : [{ whatsapp_config_id: 'cfg-A1', used: 1000, billable: 1 }];
    const client = makeClient();
    type RpcFn = (name: string, args: Record<string, unknown>) => unknown;
    const origRpc = (client as unknown as { rpc: RpcFn }).rpc;
    (client as unknown as { rpc: RpcFn }).rpc = (
      name: string,
      args: Record<string, unknown>
    ) => {
      db.usage['acct-A'] = rpcFor(args.p_since as string);
      return origRpc(name, args);
    };
    const paused = await isAiPausedByServiceCap(client, {
      accountId: 'acct-A',
      conversationId: 'conv-1',
      sealedConfigId: 'cfg-A1',
      now: new Date('2026-11-01T00:00:01Z'),
    });
    expect(paused).toBe(false);
    expect(db.rpcCalls[0].args.p_since).toBe('2026-11-01T00:00:00.000Z');
  });

  describe('fails open (R11): every read failing → false + console.warn', () => {
    beforeEach(() => {
      db.usage['acct-A'] = [
        { whatsapp_config_id: 'cfg-A1', used: 5000, billable: 4000 },
      ];
    });
    it('accounts', async () => {
      db.errors.accounts = { message: 'boom' };
      expect(await check('cfg-A1')).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    });
    it('subscriptions', async () => {
      db.errors.subscriptions = { message: 'boom' };
      expect(await check('cfg-A1')).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    });
    it('whatsapp_config', async () => {
      db.errors.whatsapp_config = { message: 'boom' };
      expect(await check('cfg-A1')).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    });
    it('the RPC resolving with an error', async () => {
      db.errors.rpc = { message: 'boom' };
      expect(await check('cfg-A1')).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    });
    it('the RPC throwing', async () => {
      db.rpcThrows = true;
      expect(await check('cfg-A1')).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    });
  });
});
