import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDatabase } from '@/lib/security/fake-supabase';
import type { Row, Tables } from '@/lib/security/fake-supabase';
import { unscopedServiceRoleQueries } from '@/lib/security/service-role-audit';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  NO_DATA_CATEGORY,
  parsePricingAnalytics,
  reconcileOne,
  reconcileStatements,
  reconciliationWindow,
  snapshotRows,
  sweepMetaReconciliation,
  type FetchPricingAnalytics,
} from './meta-reconciliation';

// s10.7 — the reconciliation with Meta. The parser of
// `pricing_analytics` (an UNVERIFIED shape: anything odd means «no
// snapshot»), the sweep of the billing cron against the in-memory
// database with every call to Graph mocked (no network), and the sums
// shown on the operator's file. A↔B: nothing of one account lands on
// or is read for the other.

const A = 'aaaaaaaa-0000-4000-8000-000000000001'; // managed, WABA W-A
const B = 'bbbbbbbb-0000-4000-8000-000000000002'; // managed, WABA W-B
const C = 'cccccccc-0000-4000-8000-000000000003'; // direct
const D = 'dddddddd-0000-4000-8000-000000000004'; // managed, disconnected

const NOW = new Date('2026-11-15T06:00:00.000Z');
const OCT_1 = Date.UTC(2026, 9, 1) / 1000;
const DAY = 86_400;

function point(
  dayOffset: number,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    start: OCT_1 + dayOffset * DAY,
    end: OCT_1 + (dayOffset + 1) * DAY,
    phone_number: '18095550001',
    pricing_category: 'MARKETING',
    pricing_type: 'REGULAR',
    volume: 100,
    cost: 7.4,
    ...over,
  };
}

function analytics(points: Record<string, unknown>[]): unknown {
  return { pricing_analytics: { data: [{ data_points: points }] }, id: 'x' };
}

function seed(): Tables {
  return {
    subscriptions: [
      { id: 's-a', account_id: A, meta_billing: 'managed', status: 'active' },
      { id: 's-b', account_id: B, meta_billing: 'managed', status: 'active' },
      { id: 's-c', account_id: C, meta_billing: 'direct', status: 'active' },
      { id: 's-d', account_id: D, meta_billing: 'managed', status: 'active' },
    ],
    whatsapp_config: [
      {
        id: 'num-a1',
        account_id: A,
        status: 'connected',
        waba_id: 'W-A',
        access_token: encrypt('token-a'),
        display_phone_number: '+1 809-555-0001',
      },
      {
        id: 'num-b1',
        account_id: B,
        status: 'connected',
        waba_id: 'W-B',
        access_token: encrypt('token-b'),
        display_phone_number: '+1 809-555-0002',
      },
      {
        id: 'num-c1',
        account_id: C,
        status: 'connected',
        waba_id: 'W-C',
        access_token: encrypt('token-c'),
        display_phone_number: '+1 809-555-0003',
      },
      {
        id: 'num-d1',
        account_id: D,
        status: 'disconnected',
        waba_id: 'W-D',
        access_token: encrypt('token-d'),
        display_phone_number: '+1 809-555-0004',
      },
    ],
    meta_spend_snapshots: [],
  };
}

let db: FakeDatabase;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  db = new FakeDatabase(seed());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const snapshotsOf = (accountId: string) =>
  db.rows('meta_spend_snapshots').filter((r) => r.account_id === accountId);

/** A Graph mock that answers per WABA and records what it was asked. */
function graph(answers: Record<string, unknown | Error>) {
  const calls: { wabaId: string; accessToken: string; start: number }[] = [];
  const fn: FetchPricingAnalytics = async (args) => {
    calls.push({
      wabaId: args.wabaId,
      accessToken: args.accessToken,
      start: args.start,
    });
    const answer = answers[args.wabaId];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fn, calls };
}

describe('parsePricingAnalytics — the assumed shape, and nothing else', () => {
  it('reads the points: lowercased category, digits of the phone, numeric strings', () => {
    const points = parsePricingAnalytics(
      analytics([
        point(0),
        point(1, {
          pricing_category: 'Authentication_International',
          volume: '3',
          cost: '0.25',
          phone_number: '+1 (809) 555-0001',
        }),
      ])
    );
    expect(points).toHaveLength(2);
    expect(points![0]).toMatchObject({
      start: OCT_1,
      end: OCT_1 + DAY,
      phone: '18095550001',
      category: 'marketing',
      volume: 100,
      cost: 7.4,
    });
    expect(points![1]).toMatchObject({
      category: 'authentication_international',
      volume: 3,
      cost: 0.25,
      phone: '18095550001',
    });
  });

  it('an empty answer is valid and means «no data»', () => {
    expect(parsePricingAnalytics({ pricing_analytics: { data: [] } })).toEqual(
      []
    );
    expect(
      parsePricingAnalytics({
        pricing_analytics: { data: [{ data_points: [] }] },
      })
    ).toEqual([]);
    expect(
      parsePricingAnalytics({ pricing_analytics: { data: [{}] } })
    ).toEqual([]);
  });

  it('anything odd invalidates the WHOLE answer (null): never an invented cost', () => {
    const odd: unknown[] = [
      null,
      'nope',
      [],
      { id: 'W-A' }, // no pricing_analytics
      { pricing_analytics: [] },
      { pricing_analytics: { data: {} } },
      { pricing_analytics: { data: ['x'] } },
      { pricing_analytics: { data: [{ data_points: {} }] } },
      analytics([point(0), { ...point(1), cost: undefined }]),
      analytics([{ ...point(0), volume: undefined }]),
      analytics([{ ...point(0), volume: -1 }]),
      analytics([{ ...point(0), volume: 1.5 }]),
      analytics([{ ...point(0), cost: -0.01 }]),
      analytics([{ ...point(0), cost: 'NaN' }]),
      analytics([{ ...point(0), end: OCT_1 }]),
      analytics([{ ...point(0), start: 'yesterday' }]),
      analytics([{ ...point(0), pricing_category: '' }]),
      analytics([{ ...point(0), pricing_category: 7 }]),
      analytics([{ ...point(0), pricing_category: NO_DATA_CATEGORY }]),
    ];
    for (const body of odd) {
      expect(parsePricingAnalytics(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe('snapshotRows and the window', () => {
  it('maps PHONE to the account number by digits; an unknown phone is NULL; same key is summed', () => {
    const points = parsePricingAnalytics(
      analytics([
        point(0),
        point(0, { pricing_type: 'FREE_ENTRY_POINT', volume: 5, cost: 0 }),
        point(0, { phone_number: '19995550000', volume: 1, cost: 0.074 }),
      ])
    )!;
    const rows = snapshotRows({
      accountId: A,
      wabaId: 'W-A',
      points,
      configs: [{ id: 'num-a1', display_phone_number: '+1 809-555-0001' }],
      fetchedAt: NOW.toISOString(),
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      account_id: A,
      whatsapp_config_id: 'num-a1',
      waba_id: 'W-A',
      period_start: '2026-10-01T00:00:00.000Z',
      period_end: '2026-10-02T00:00:00.000Z',
      category: 'marketing',
      volume: 105,
      cost_usd: 7.4,
    });
    expect((rows[0].raw.points as unknown[]).length).toBe(2);
    expect(rows[1]).toMatchObject({ whatsapp_config_id: null, volume: 1 });
  });

  it('asks from the first day of the previous month (UTC), also across a year', () => {
    expect(reconciliationWindow(NOW).start.toISOString()).toBe(
      '2026-10-01T00:00:00.000Z'
    );
    expect(
      reconciliationWindow(
        new Date('2027-01-03T10:00:00.000Z')
      ).start.toISOString()
    ).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('sweepMetaReconciliation — the billing cron sweep', () => {
  it('fetches only managed accounts with a connected number, WABA and token, and stores their days', async () => {
    const g = graph({
      'W-A': analytics([point(0), point(1, { pricing_category: 'UTILITY' })]),
      'W-B': analytics([point(0, { phone_number: '18095550002', cost: 1 })]),
    });
    const summary = await sweepMetaReconciliation(db.admin as never, {
      now: NOW,
      fetchAnalytics: g.fn,
    });
    expect(summary).toEqual({ scanned: 2, fetched: 2, skipped: 0, failed: 0 });
    expect(g.calls.map((c) => c.wabaId).sort()).toEqual(['W-A', 'W-B']);
    // Each WABA with ITS account's token, decrypted.
    expect(g.calls.find((c) => c.wabaId === 'W-A')!.accessToken).toBe(
      'token-a'
    );
    expect(g.calls.find((c) => c.wabaId === 'W-B')!.accessToken).toBe(
      'token-b'
    );
    expect(g.calls[0].start).toBe(OCT_1);
    expect(snapshotsOf(A)).toHaveLength(2);
    expect(snapshotsOf(A).every((r) => r.waba_id === 'W-A')).toBe(true);
    expect(snapshotsOf(A)[0]).toMatchObject({
      whatsapp_config_id: 'num-a1',
      fetched_at: NOW.toISOString(),
    });
    expect(snapshotsOf(B)).toHaveLength(1);
    expect(snapshotsOf(B)[0]).toMatchObject({
      waba_id: 'W-B',
      whatsapp_config_id: 'num-b1',
      cost_usd: 1,
    });
    expect(snapshotsOf(C)).toEqual([]);
    expect(snapshotsOf(D)).toEqual([]);
  });

  it('at most once a day per account: a second run skips; 24 h later it refreshes without duplicating', async () => {
    const g = graph({
      'W-A': analytics([point(0)]),
      'W-B': analytics([point(0, { phone_number: '18095550002' })]),
    });
    await sweepMetaReconciliation(db.admin as never, {
      now: NOW,
      fetchAnalytics: g.fn,
    });
    const again = await sweepMetaReconciliation(db.admin as never, {
      now: new Date(NOW.getTime() + 60 * 60_000),
      fetchAnalytics: g.fn,
    });
    expect(again).toEqual({ scanned: 2, fetched: 0, skipped: 2, failed: 0 });
    expect(g.calls).toHaveLength(2);

    const later = new Date(NOW.getTime() + 24 * 60 * 60_000);
    const g2 = graph({
      'W-A': analytics([point(0, { cost: 8 })]),
      'W-B': analytics([point(0, { phone_number: '18095550002' })]),
    });
    const third = await sweepMetaReconciliation(db.admin as never, {
      now: later,
      fetchAnalytics: g2.fn,
    });
    expect(third.fetched).toBe(2);
    expect(snapshotsOf(A)).toHaveLength(1);
    expect(snapshotsOf(A)[0]).toMatchObject({
      cost_usd: 8,
      fetched_at: later.toISOString(),
    });
  });

  it('an odd answer stores nothing for that WABA, counts as failed, and is retried on the next run', async () => {
    const g = graph({
      'W-A': { pricing_analytics: { data: [{ data_points: [{ start: 1 }] }] } },
      'W-B': analytics([point(0, { phone_number: '18095550002' })]),
    });
    const summary = await sweepMetaReconciliation(db.admin as never, {
      now: NOW,
      fetchAnalytics: g.fn,
    });
    expect(summary).toEqual({ scanned: 2, fetched: 1, skipped: 0, failed: 1 });
    expect(snapshotsOf(A)).toEqual([]);
    expect(snapshotsOf(B)).toHaveLength(1);

    const retry = await sweepMetaReconciliation(db.admin as never, {
      now: new Date(NOW.getTime() + 60 * 60_000),
      fetchAnalytics: graph({ 'W-A': analytics([point(0)]) }).fn,
    });
    expect(retry).toMatchObject({ fetched: 1, skipped: 1, failed: 0 });
    expect(snapshotsOf(A)).toHaveLength(1);
  });

  it('a valid empty answer stores the `_none` mark of the day, so the day is not asked again', async () => {
    const g = graph({
      'W-A': { pricing_analytics: { data: [] } },
      'W-B': analytics([point(0, { phone_number: '18095550002' })]),
    });
    await sweepMetaReconciliation(db.admin as never, {
      now: NOW,
      fetchAnalytics: g.fn,
    });
    expect(snapshotsOf(A)).toEqual([
      expect.objectContaining({
        account_id: A,
        waba_id: 'W-A',
        whatsapp_config_id: null,
        category: NO_DATA_CATEGORY,
        volume: 0,
        cost_usd: 0,
        period_start: '2026-11-15T00:00:00.000Z',
        period_end: '2026-11-16T00:00:00.000Z',
      }),
    ]);
    const again = await sweepMetaReconciliation(db.admin as never, {
      now: new Date(NOW.getTime() + 60 * 60_000),
      fetchAnalytics: g.fn,
    });
    expect(again.skipped).toBe(2);
  });

  it('CP11: Meta failing, a token that cannot be read or the database failing never throw out of the sweep', async () => {
    db.rows('whatsapp_config').find((r) => r.id === 'num-b1')!.access_token =
      'not-a-ciphertext';
    const g = graph({ 'W-A': new Error('(#100) Unsupported get request') });
    const summary = await sweepMetaReconciliation(db.admin as never, {
      now: NOW,
      fetchAnalytics: g.fn,
    });
    expect(summary).toEqual({ scanned: 2, fetched: 0, skipped: 0, failed: 2 });
    // B's token was unreadable: Graph was never asked for it.
    expect(g.calls.map((c) => c.wabaId)).toEqual(['W-A']);
    expect(db.rows('meta_spend_snapshots')).toEqual([]);

    const broken = {
      from: () => {
        throw new Error('database down');
      },
    };
    await expect(
      sweepMetaReconciliation(broken as never, {
        now: NOW,
        fetchAnalytics: g.fn,
      })
    ).resolves.toEqual({ scanned: 0, fetched: 0, skipped: 0, failed: 0 });
  });

  it('a batch limit: the rest waits for the next run (counted as skipped)', async () => {
    const g = graph({
      'W-A': analytics([point(0)]),
      'W-B': analytics([point(0, { phone_number: '18095550002' })]),
    });
    const summary = await sweepMetaReconciliation(db.admin as never, {
      now: NOW,
      fetchLimit: 1,
      fetchAnalytics: g.fn,
    });
    expect(summary).toEqual({ scanned: 2, fetched: 1, skipped: 1, failed: 0 });
    expect(g.calls).toHaveLength(1);
  });

  it('A↔B: every write carries the account it belongs to, every read of the snapshots is filtered by account', async () => {
    const g = graph({
      'W-A': analytics([point(0)]),
      // B's WABA answers with A's phone: it still lands on B, unmatched.
      'W-B': analytics([point(0, { phone_number: '18095550001' })]),
    });
    await sweepMetaReconciliation(db.admin as never, {
      now: NOW,
      fetchAnalytics: g.fn,
    });
    // The repo's service-role audit: the only unscoped query is the
    // listing of managed subscriptions, which is the sweep itself.
    expect(
      unscopedServiceRoleQueries(db.log, [
        {
          table: 'subscriptions',
          op: 'select',
          by: ['meta_billing'],
          reason: 'cross-account sweep of managed accounts (s10.7)',
        },
      ])
    ).toEqual([]);
    const writes = db.log.filter((e) => e.op !== 'select');
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.table).toBe('meta_spend_snapshots');
      expect(w.op).toBe('upsert');
      const accounts = new Set((w.payload ?? []).map((r) => r.account_id));
      expect(accounts.size).toBe(1);
    }
    for (const e of db.log.filter(
      (x) => x.table === 'meta_spend_snapshots' && x.op === 'select'
    )) {
      expect(e.filters.some((f) => f.column === 'account_id')).toBe(true);
    }
    const configRead = db.log.find((e) => e.table === 'whatsapp_config')!;
    expect(
      configRead.filters.some((f) => f.column === 'account_id' && f.op === 'in')
    ).toBe(true);
    // B's row is B's, and never mapped to A's number.
    expect(snapshotsOf(B)).toEqual([
      expect.objectContaining({ waba_id: 'W-B', whatsapp_config_id: null }),
    ]);
    expect(
      db
        .rows('meta_spend_snapshots')
        .filter((r) => r.whatsapp_config_id === 'num-a1')
    ).toHaveLength(1);
  });

  it('the default Graph call: GET the WABA with the pricing_analytics expansion, bearer token, nothing in the URL', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(analytics([point(0)])))
    );
    vi.stubGlobal('fetch', fetchMock);
    db.rows('subscriptions').splice(1); // only A
    const summary = await sweepMetaReconciliation(db.admin as never, {
      now: NOW,
    });
    expect(summary.fetched).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const decoded = decodeURIComponent(url);
    expect(url.startsWith('https://graph.facebook.com/v21.0/W-A?fields=')).toBe(
      true
    );
    expect(decoded).toContain(
      `pricing_analytics.start(${OCT_1}).end(${Math.floor(NOW.getTime() / 1000)})`
    );
    expect(decoded).toContain('.granularity(DAILY)');
    expect(decoded).toContain('.metric_types(["COST","VOLUME"])');
    expect(decoded).toContain('.dimensions(["PHONE","PRICING_CATEGORY"])');
    expect(url).not.toContain('token-a');
    expect(init.headers).toEqual({ Authorization: 'Bearer token-a' });
    expect(snapshotsOf(A)).toHaveLength(1);
  });

  it('a Graph HTTP error through the default call is a failure, not a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: 'Invalid parameter', code: 100 },
            }),
            { status: 400 }
          )
      )
    );
    db.rows('subscriptions').splice(1);
    await expect(
      sweepMetaReconciliation(db.admin as never, { now: NOW })
    ).resolves.toEqual({ scanned: 1, fetched: 0, skipped: 0, failed: 1 });
  });
});

describe('reconcileOne / reconcileStatements — the operator file', () => {
  const statementA = {
    id: 'st-a',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    metaCostUsd: 520.26,
  };

  function snap(accountId: string, over: Partial<Row>): Row {
    return {
      account_id: accountId,
      whatsapp_config_id: null,
      waba_id: 'W-A',
      period_start: '2026-10-05T00:00:00.000Z',
      period_end: '2026-10-06T00:00:00.000Z',
      category: 'marketing',
      volume: 100,
      cost_usd: 7.4,
      fetched_at: '2026-11-02T00:00:00.000Z',
      raw: {},
      ...over,
    };
  }

  it('the difference is our cost − what Meta reports in the period, per WABA too; only A’s rows count (A↔B)', async () => {
    db.rows('meta_spend_snapshots').push(
      snap(A, { cost_usd: 500, volume: 6000 }),
      snap(A, {
        period_start: '2026-10-31T00:00:00.000Z',
        period_end: '2026-11-01T00:00:00.000Z',
        cost_usd: 10.5,
        volume: 200,
        category: 'utility',
      }),
      snap(A, { waba_id: 'W-A2', cost_usd: 4, volume: 50 }),
      // Outside the period (next statement's first day).
      snap(A, {
        period_start: '2026-11-01T00:00:00.000Z',
        period_end: '2026-11-02T00:00:00.000Z',
        cost_usd: 99,
      }),
      // B, same period and WABA id: must never be summed into A.
      snap(B, { cost_usd: 1000, volume: 9999 })
    );
    const out = await reconcileStatements(db.admin as never, A, [statementA]);
    expect(out.get('st-a')).toEqual({
      metaReportedCostUsd: 514.5,
      differenceUsd: 5.76,
      volume: 6250,
      wabas: [
        { wabaId: 'W-A', metaReportedCostUsd: 510.5, volume: 6200 },
        { wabaId: 'W-A2', metaReportedCostUsd: 4, volume: 50 },
      ],
      lastFetchedAt: '2026-11-02T00:00:00.000Z',
      partial: false,
    });
    for (const e of db.log.filter((x) => x.table === 'meta_spend_snapshots')) {
      expect(e.filters).toContainEqual(
        expect.objectContaining({ column: 'account_id', op: 'eq', value: A })
      );
    }
  });

  it('no row in the period → «sin dato de Meta» (null), even if other periods have data', async () => {
    db.rows('meta_spend_snapshots').push(
      snap(A, {
        period_start: '2026-09-10T00:00:00.000Z',
        period_end: '2026-09-11T00:00:00.000Z',
      }),
      snap(B, {})
    );
    const out = await reconcileStatements(db.admin as never, A, [statementA]);
    expect(out.get('st-a')).toMatchObject({
      metaReportedCostUsd: null,
      differenceUsd: null,
      volume: null,
      wabas: [],
    });
  });

  it('the `_none` mark is «Meta says 0», not «no data»; a last reading before the period end is partial', () => {
    const r = reconcileOne(
      statementA,
      [
        {
          waba_id: 'W-A',
          period_start: '2026-10-20T00:00:00.000Z',
          category: NO_DATA_CATEGORY,
          volume: 0,
          cost_usd: 0,
          fetched_at: '2026-10-20T06:00:00.000Z',
        },
      ],
      '2026-10-20T06:00:00.000Z'
    );
    expect(r).toMatchObject({
      metaReportedCostUsd: 0,
      differenceUsd: 520.26,
      volume: 0,
      partial: true,
    });
  });

  it('a period anchored mid-day is rounded to UTC days: each Meta day falls in exactly one statement', () => {
    const rows = [
      '2026-10-15T00:00:00.000Z',
      '2026-11-14T00:00:00.000Z',
      '2026-11-15T00:00:00.000Z',
    ].map((d) => ({
      waba_id: 'W-A',
      period_start: d,
      category: 'marketing',
      volume: 1,
      cost_usd: '1.000000',
      fetched_at: '2026-12-01T00:00:00.000Z',
    }));
    const first = reconcileOne(
      {
        periodStart: '2026-10-15T14:23:00.000Z',
        periodEnd: '2026-11-15T14:23:00.000Z',
        metaCostUsd: 2,
      },
      rows,
      '2026-12-01T00:00:00.000Z'
    );
    const second = reconcileOne(
      {
        periodStart: '2026-11-15T14:23:00.000Z',
        periodEnd: '2026-12-15T14:23:00.000Z',
        metaCostUsd: 1,
      },
      rows,
      '2026-12-01T00:00:00.000Z'
    );
    expect(first).toMatchObject({ metaReportedCostUsd: 2, differenceUsd: 0 });
    expect(second).toMatchObject({
      metaReportedCostUsd: 1,
      differenceUsd: 0,
      partial: true,
    });
  });

  it('no statements → nothing read', async () => {
    expect((await reconcileStatements(db.admin as never, A, [])).size).toBe(0);
    expect(db.log).toEqual([]);
  });
});
