import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SMB_SYNC_CLAIM_TTL_MS,
  SMB_SYNC_WINDOW_MS,
  classifyBizAppStatus,
  isWithinSmbSyncWindow,
  pickCoexistencePhoneNumber,
  runSmbAppDataSync,
} from './coexistence';

// ---------------------------------------------------------------------------
// #1650 R7–R10 — the once-only SMB syncs of a coexistence number.
//
// A fake service-role client that keeps ONE whatsapp_config row in memory
// and evaluates the claim (`.is(request_id, null)` + `.or(requested_at …)`)
// the way PostgREST would, recording every write with its filters.
// ---------------------------------------------------------------------------

type Row = Record<string, string | null>;
type Write = {
  op: 'update' | 'select';
  payload?: Record<string, unknown>;
  filters: [string, string, unknown][];
};

const TOKEN = 'EAAB-coexistence-secret-token';
const NOW = new Date('2026-11-02T12:00:00.000Z');

function makeAdmin(row: Row, opts: { failUpdates?: boolean } = {}) {
  const writes: Write[] = [];
  const admin = {
    from(table: string) {
      expect(table).toBe('whatsapp_config');
      const w: Write = { op: 'select', filters: [] };
      const matches = () =>
        w.filters.every(([kind, col, val]) => {
          if (kind === 'eq') return row[col] === val;
          if (kind === 'is') return row[col] === val;
          if (kind === 'or') {
            // `<col>.is.null,<col>.lt.<iso>`
            const [a, b] = String(val).split(',');
            const c = a.split('.')[0];
            const cutoff = b.split('.lt.')[1];
            return row[c] === null || Date.parse(row[c]!) < Date.parse(cutoff);
          }
          return true;
        });
      const run = () => {
        if (w.op === 'update') {
          writes.push(w);
          if (opts.failUpdates) {
            return { data: null, error: { message: 'db down' } };
          }
          if (!matches()) return { data: [], error: null };
          Object.assign(row, w.payload);
          return { data: [{ id: row.id }], error: null };
        }
        return { data: matches() ? { ...row } : null, error: null };
      };
      const chain: Record<string, unknown> = {
        update(payload: Record<string, unknown>) {
          w.op = 'update';
          w.payload = payload;
          return chain;
        },
        select() {
          return chain;
        },
        eq(col: string, val: unknown) {
          w.filters.push(['eq', col, val]);
          return chain;
        },
        is(col: string, val: unknown) {
          w.filters.push(['is', col, val]);
          return chain;
        },
        or(expr: string) {
          w.filters.push(['or', '', expr]);
          return chain;
        },
        maybeSingle: async () => run(),
        then(resolve: (v: unknown) => unknown) {
          return resolve(run());
        },
      };
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient, writes };
}

function freshRow(extra: Row = {}): Row {
  return {
    id: 'cfg-1',
    account_id: 'acct-1',
    smb_state_sync_requested_at: null,
    smb_state_sync_request_id: null,
    smb_history_sync_requested_at: null,
    smb_history_sync_request_id: null,
    smb_sync_error: null,
    ...extra,
  };
}

const ARGS = {
  accountId: 'acct-1',
  configId: 'cfg-1',
  phoneNumberId: 'pn-1',
  accessToken: TOKEN,
};

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  vi.restoreAllMocks();
});
function consoleOutput(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' | ');
}

describe('runSmbAppDataSync', () => {
  it('requests both syncs in Meta order and persists both request ids (R7, R10)', async () => {
    const row = freshRow({ smb_sync_error: 'old failure' });
    const { admin, writes } = makeAdmin(row);
    const sync = vi.fn(async ({ syncType }: { syncType: string }) => ({
      requestId: `req-${syncType}`,
    }));
    const outcome = await runSmbAppDataSync(admin, ARGS, {
      sync,
      now: () => NOW,
    });

    expect(outcome).toEqual({ state_sync: 'requested', history: 'requested' });
    expect(sync.mock.calls.map((c) => c[0].syncType)).toEqual([
      'smb_app_state_sync',
      'history',
    ]);
    for (const call of sync.mock.calls) {
      expect(call[0]).toMatchObject({
        phoneNumberId: 'pn-1',
        accessToken: TOKEN,
      });
    }
    expect(row.smb_state_sync_request_id).toBe('req-smb_app_state_sync');
    expect(row.smb_history_sync_request_id).toBe('req-history');
    expect(row.smb_state_sync_requested_at).toBe(NOW.toISOString());
    expect(row.smb_history_sync_requested_at).toBe(NOW.toISOString());
    // R10 — all good: the error column is cleared.
    expect(row.smb_sync_error).toBeNull();

    // Every write scoped by row id AND account id.
    const updates = writes.filter((w) => w.op === 'update');
    expect(updates.length).toBeGreaterThan(0);
    for (const w of updates) {
      expect(w.filters).toContainEqual(['eq', 'id', 'cfg-1']);
      expect(w.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    }
  });

  it('a row that already has both request ids → already_done, zero Meta calls (R8)', async () => {
    const row = freshRow({
      smb_state_sync_request_id: 'r1',
      smb_state_sync_requested_at: '2026-11-02T10:00:00.000Z',
      smb_history_sync_request_id: 'r2',
      smb_history_sync_requested_at: '2026-11-02T10:00:00.000Z',
    });
    const { admin } = makeAdmin(row);
    const sync = vi.fn();
    const outcome = await runSmbAppDataSync(admin, ARGS, {
      sync,
      now: () => NOW,
    });
    expect(outcome).toEqual({
      state_sync: 'already_done',
      history: 'already_done',
    });
    expect(sync).not.toHaveBeenCalled();
    expect(row.smb_state_sync_request_id).toBe('r1');
  });

  it('a fresh claim held by another pass → in_flight, zero Meta calls (R8)', async () => {
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    const row = freshRow({
      smb_state_sync_requested_at: recent,
      smb_history_sync_requested_at: recent,
    });
    const { admin } = makeAdmin(row);
    const sync = vi.fn();
    const outcome = await runSmbAppDataSync(admin, ARGS, {
      sync,
      now: () => NOW,
    });
    expect(outcome).toEqual({ state_sync: 'in_flight', history: 'in_flight' });
    expect(sync).not.toHaveBeenCalled();
  });

  it('two concurrent passes on one row call Meta once per type (R8)', async () => {
    const row = freshRow();
    const { admin } = makeAdmin(row);
    const sync = vi.fn(async ({ syncType }: { syncType: string }) => ({
      requestId: `req-${syncType}`,
    }));
    const [a, b] = await Promise.all([
      runSmbAppDataSync(admin, ARGS, { sync, now: () => NOW }),
      runSmbAppDataSync(admin, ARGS, { sync, now: () => NOW }),
    ]);
    expect(sync).toHaveBeenCalledTimes(2);
    expect([a.state_sync, b.state_sync].sort()).toEqual([
      'in_flight',
      'requested',
    ]);
  });

  it('an abandoned claim (older than the TTL) can be retaken', async () => {
    const stale = new Date(
      NOW.getTime() - SMB_SYNC_CLAIM_TTL_MS - 1000
    ).toISOString();
    const row = freshRow({ smb_state_sync_requested_at: stale });
    const { admin } = makeAdmin(row);
    const sync = vi.fn(async () => ({ requestId: 'req' }));
    const outcome = await runSmbAppDataSync(admin, ARGS, {
      sync,
      now: () => NOW,
    });
    expect(outcome.state_sync).toBe('requested');
  });

  it('a failure releases its claim, goes on with the other type, and records the error (R9)', async () => {
    const row = freshRow();
    const { admin } = makeAdmin(row);
    const sync = vi.fn(async ({ syncType }: { syncType: string }) => {
      if (syncType === 'smb_app_state_sync') {
        throw new Error('x'.repeat(800));
      }
      return { requestId: 'req-history' };
    });
    const outcome = await runSmbAppDataSync(admin, ARGS, {
      sync,
      now: () => NOW,
    });
    expect(outcome).toEqual({ state_sync: 'failed', history: 'requested' });
    expect(sync).toHaveBeenCalledTimes(2);
    // Claim released so the manual retry can take it.
    expect(row.smb_state_sync_requested_at).toBeNull();
    expect(row.smb_state_sync_request_id).toBeNull();
    expect(row.smb_history_sync_request_id).toBe('req-history');
    expect(row.smb_sync_error?.startsWith('smb_app_state_sync: x')).toBe(true);
    expect(row.smb_sync_error).toHaveLength(500);
  });

  it('a Supabase write failure yields failed without throwing', async () => {
    const row = freshRow();
    const { admin } = makeAdmin(row, { failUpdates: true });
    const sync = vi.fn();
    const outcome = await runSmbAppDataSync(admin, ARGS, {
      sync,
      now: () => NOW,
    });
    expect(outcome).toEqual({ state_sync: 'failed', history: 'failed' });
    expect(sync).not.toHaveBeenCalled();
  });

  it('never prints the token (R9)', async () => {
    const row = freshRow();
    const { admin } = makeAdmin(row);
    const sync = vi.fn(async () => {
      throw new Error('Invalid OAuth access token');
    });
    await runSmbAppDataSync(admin, ARGS, { sync, now: () => NOW });
    expect(consoleOutput()).not.toContain(TOKEN);
    expect(row.smb_sync_error ?? '').not.toContain(TOKEN);
  });
});

describe('classifyBizAppStatus', () => {
  it('maps is_on_biz_app + platform_type', () => {
    expect(classifyBizAppStatus(true, 'CLOUD_API')).toBe('coexistence');
    expect(classifyBizAppStatus(true, 'ON_PREMISE')).toBe('biz_app_only');
    expect(classifyBizAppStatus(true, 'NOT_APPLICABLE')).toBe('biz_app_only');
    expect(classifyBizAppStatus(true, null)).toBe('unknown');
    expect(classifyBizAppStatus(false, 'CLOUD_API')).toBe('not_on_biz_app');
    expect(classifyBizAppStatus(undefined, undefined)).toBe('unknown');
    expect(classifyBizAppStatus('true', 'CLOUD_API')).toBe('unknown');
  });
});

describe('isWithinSmbSyncWindow', () => {
  it('is true inside 24 h of the onboarding and false outside', () => {
    const inside = new Date(NOW.getTime() - SMB_SYNC_WINDOW_MS + 60_000);
    const outside = new Date(NOW.getTime() - SMB_SYNC_WINDOW_MS - 60_000);
    expect(isWithinSmbSyncWindow(inside.toISOString(), NOW)).toBe(true);
    expect(isWithinSmbSyncWindow(outside.toISOString(), NOW)).toBe(false);
    expect(isWithinSmbSyncWindow(null, NOW)).toBe(false);
    expect(isWithinSmbSyncWindow('not a date', NOW)).toBe(false);
  });
});

describe('pickCoexistencePhoneNumber (ajuste del leader 2026-11-02)', () => {
  it('picks the only number on the business app', () => {
    expect(
      pickCoexistencePhoneNumber([
        { id: 'pn-api', is_on_biz_app: false },
        { id: 'pn-app', is_on_biz_app: true },
      ])
    ).toEqual({ ok: true, phoneNumberId: 'pn-app' });
  });

  it('refuses none or more than one', () => {
    expect(pickCoexistencePhoneNumber([{ id: 'a' }])).toEqual({
      ok: false,
      reason: 'none',
    });
    expect(
      pickCoexistencePhoneNumber([
        { id: 'a', is_on_biz_app: true },
        { id: 'b', is_on_biz_app: true },
      ])
    ).toEqual({ ok: false, reason: 'ambiguous' });
  });
});
