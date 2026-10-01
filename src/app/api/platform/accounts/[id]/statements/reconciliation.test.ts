import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// s10.7 — the reconciliation with Meta on the operator's file: GET the
// statements of A brings, per statement, what Meta's `pricing_analytics`
// reports for the period and the difference with our real cost, or
// «sin dato de Meta». Two managed companies with snapshots in the same
// period and the same WABA id: A's file never sums B's (A↔B), and the
// list still loads when the snapshots cannot be read.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  failSnapshots: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => {
    const client = h.db.admin;
    if (!h.failSnapshots) return client;
    return {
      ...client,
      from: (table: string) => {
        if (table !== 'meta_spend_snapshots') return client.from(table);
        throw new Error('relation "meta_spend_snapshots" does not exist');
      },
    };
  },
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, reset: 0 }),
}));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { GET } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

function statement(id: string, accountId: string, start: string, end: string) {
  return {
    id,
    account_id: accountId,
    period_start: start,
    period_end: end,
    plan_fee_usd: 1036,
    usage_charge_usd: 0,
    total_usd: 1036,
    meta_cost_usd: 300,
    included_messages: 7000,
    messages_total: 4000,
    overage_messages: 0,
    usage: { version: 1, lines: [] },
    status: 'paid',
    issued_at: end,
    due_at: end,
    paid_at: end,
  };
}

function snap(accountId: string, day: string, cost: number, volume = 100) {
  const start = new Date(day);
  return {
    id: `snap-${accountId}-${day}-${cost}`,
    account_id: accountId,
    whatsapp_config_id: null,
    waba_id: 'W-SHARED',
    period_start: start.toISOString(),
    period_end: new Date(start.getTime() + 86_400_000).toISOString(),
    category: 'marketing',
    volume,
    cost_usd: cost,
    fetched_at: '2026-11-02T06:00:00.000Z',
    raw: {},
  };
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.failSnapshots = false;
  h.db = new FakeDatabase({
    platform_admins: [
      { id: 'pa-1', user_id: OPERATOR, granted_at: null, note: 'test' },
    ],
    accounts: [
      { id: A, name: 'Company A', created_at: '2026-01-01T00:00:00.000Z' },
      { id: B, name: 'Company B', created_at: '2026-01-01T00:00:00.000Z' },
    ],
    subscriptions: [],
    statements: [
      statement(
        'st-b-oct',
        B,
        '2026-10-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z'
      ),
      statement(
        'st-a-oct',
        A,
        '2026-10-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z'
      ),
      statement(
        'st-a-sep',
        A,
        '2026-09-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z'
      ),
    ],
    meta_spend_snapshots: [
      snap(A, '2026-10-03T00:00:00.000Z', 200),
      snap(A, '2026-10-20T00:00:00.000Z', 95.5),
      snap(B, '2026-10-03T00:00:00.000Z', 5000, 70000),
    ],
    impersonation_log: [],
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function list(id = A) {
  return GET(
    new Request(`http://localhost/api/platform/accounts/${id}/statements`),
    { params: Promise.resolve({ id }) }
  );
}

describe('GET — reconciliation on the file', () => {
  it('per statement: Meta’s cost of the period, the difference with ours, and «sin dato» where there is none — only A’s rows (A↔B)', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(
      (body.statements as { id: string; reconciliation?: unknown }[]).map(
        (s) => [s.id, s]
      )
    );
    expect(Object.keys(byId).sort()).toEqual(['st-a-oct', 'st-a-sep']);
    expect(byId['st-a-oct'].reconciliation).toEqual({
      metaReportedCostUsd: 295.5,
      differenceUsd: 4.5,
      volume: 200,
      wabas: [{ wabaId: 'W-SHARED', metaReportedCostUsd: 295.5, volume: 200 }],
      lastFetchedAt: '2026-11-02T06:00:00.000Z',
      partial: false,
    });
    expect(byId['st-a-sep'].reconciliation).toMatchObject({
      metaReportedCostUsd: null,
      differenceUsd: null,
    });
    expect(JSON.stringify(body)).not.toContain('5000');
    for (const e of h.db.log.filter(
      (x) => x.table === 'meta_spend_snapshots'
    )) {
      expect(e.filters).toContainEqual(
        expect.objectContaining({ column: 'account_id', op: 'eq', value: A })
      );
    }
  });

  it('the list still loads when the snapshots cannot be read (no reconciliation block)', async () => {
    h.failSnapshots = true;
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statements).toHaveLength(2);
    for (const s of body.statements) {
      expect(s.reconciliation).toBeUndefined();
    }
  });
});
