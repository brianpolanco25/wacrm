import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The subscription area of Fase 3 §6.
//
// Four properties are worth more than the happy path, and every one of
// them is an acceptance criterion of the phase:
//
//   1. The consumption shown IS `usage_counters` — same numbers, same
//      period, no adjustment on the way out.
//   2. Nothing here activates anything. Cancel, reactivate and change
//      plan talk to PayPal; only the webhook of §3 writes a status.
//   3. A `suspended` account can still see its subscription and reach
//      the button that fixes it (§5 would otherwise lock the door with
//      the key inside).
//   4. Every query is scoped to the caller's account — including the
//      receipts, which come out of `billing_events`, a table with no
//      `account_id` at all.
//
// The Supabase mock honours `.eq()`, `.in()` and the json path used for
// the receipts, so a leak test fails when the filter goes missing and
// not when the mock is edited.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Db {
  profiles: Row[];
  accounts: Row[];
  plans: Row[];
  subscriptions: Row[];
  usage_counters: Row[];
  checkout_intents: Row[];
  billing_events: Row[];
}

interface QueryLog {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  filters: Array<[string, unknown]>;
  payload?: Row;
  serviceRole: boolean;
}

const ACCOUNT_A = 'acct-a';
const ACCOUNT_B = 'acct-b';
const PERIOD = (() => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
})();

let db: Db;
let queries: QueryLog[];
let currentUser: string;
let selectFailure: keyof Db | null;
let updateFailure: keyof Db | null;

function sale(
  id: string,
  subscriptionId: string,
  total: string,
  createTime: string
): Row {
  return {
    id,
    provider: 'paypal',
    event_type: 'PAYMENT.SALE.COMPLETED',
    received_at: createTime,
    payload: {
      resource: {
        id: `TX-${id}`,
        billing_agreement_id: subscriptionId,
        create_time: createTime,
        amount: { total, currency: 'USD' },
      },
    },
  };
}

function freshDb(): Db {
  return {
    profiles: [
      { user_id: 'user-a', account_id: ACCOUNT_A, account_role: 'admin' },
      { user_id: 'agent-a', account_id: ACCOUNT_A, account_role: 'agent' },
      { user_id: 'user-b', account_id: ACCOUNT_B, account_role: 'admin' },
    ],
    accounts: [
      { id: ACCOUNT_A, name: 'Acme' },
      { id: ACCOUNT_B, name: 'Globex' },
    ],
    plans: [
      {
        id: 'pro',
        name: 'Pro',
        is_public: true,
        limits: {
          messages_out: 15000,
          ai_replies: 3000,
          broadcast_recipients: null,
        },
        features: ['api'],
        price_usd_month: '79.00',
        price_usd_year: '790.00',
        provider_plan_id_month: 'P-PRO-MONTH',
        provider_plan_id_year: 'P-PRO-YEAR',
      },
      {
        id: 'negocio',
        name: 'Negocio',
        is_public: true,
        limits: { messages_out: 60000 },
        features: ['api'],
        price_usd_month: '199.00',
        price_usd_year: '1990.00',
        provider_plan_id_month: 'P-NEG-MONTH',
        provider_plan_id_year: null,
      },
      {
        id: 'oculto',
        name: 'Hidden',
        is_public: false,
        limits: {},
        features: [],
        price_usd_month: '9.00',
        price_usd_year: null,
        provider_plan_id_month: 'P-HIDDEN-MONTH',
        provider_plan_id_year: null,
      },
    ],
    subscriptions: [
      {
        account_id: ACCOUNT_A,
        plan_id: 'pro',
        status: 'active',
        provider: 'paypal',
        provider_subscription_id: 'I-SUB-A',
        current_period_end: '2026-10-01T00:00:00Z',
        grace_until: null,
        trial_ends_at: null,
        cancel_at_period_end: false,
        cycle: 'month',
        last_event_at: '2026-09-01T00:00:00Z',
      },
      {
        account_id: ACCOUNT_B,
        plan_id: 'negocio',
        status: 'active',
        provider: 'paypal',
        provider_subscription_id: 'I-SUB-B',
        current_period_end: '2026-11-01T00:00:00Z',
        grace_until: null,
        trial_ends_at: null,
        cancel_at_period_end: false,
        cycle: 'year',
        last_event_at: null,
      },
    ],
    usage_counters: [
      {
        account_id: ACCOUNT_A,
        metric: 'messages_out',
        period_start: PERIOD,
        value: 2731,
      },
      {
        account_id: ACCOUNT_A,
        metric: 'ai_replies',
        period_start: PERIOD,
        value: 12,
      },
      // Last month — must not be counted in "this cycle".
      {
        account_id: ACCOUNT_A,
        metric: 'messages_out',
        period_start: '2020-01-01',
        value: 99999,
      },
      {
        account_id: ACCOUNT_B,
        metric: 'messages_out',
        period_start: PERIOD,
        value: 55555,
      },
    ],
    checkout_intents: [
      {
        id: 'intent-a',
        account_id: ACCOUNT_A,
        plan_id: 'pro',
        cycle: 'month',
        provider: 'paypal',
        provider_plan_id: 'P-PRO-MONTH',
        provider_subscription_id: 'I-SUB-A',
        status: 'activated',
      },
      {
        id: 'intent-b',
        account_id: ACCOUNT_B,
        plan_id: 'negocio',
        cycle: 'year',
        provider: 'paypal',
        provider_plan_id: 'P-NEG-YEAR',
        provider_subscription_id: 'I-SUB-B',
        status: 'activated',
      },
    ],
    billing_events: [
      sale('evt-a1', 'I-SUB-A', '79.00', '2026-09-01T10:00:00Z'),
      sale('evt-a2', 'I-SUB-A', '79.00', '2026-08-01T10:00:00Z'),
      sale('evt-b1', 'I-SUB-B', '1990.00', '2026-09-02T10:00:00Z'),
      // Not a sale: must never show up as a receipt.
      {
        id: 'evt-a3',
        provider: 'paypal',
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        received_at: '2026-07-01T10:00:00Z',
        payload: { resource: { id: 'I-SUB-A' } },
      },
    ],
  };
}

/** Read `payload->resource->>billing_agreement_id` out of a stored row. */
function jsonPath(row: Row, column: string): unknown {
  if (column !== 'payload->resource->>billing_agreement_id') return undefined;
  const payload = row.payload as {
    resource?: { billing_agreement_id?: unknown };
  };
  return payload?.resource?.billing_agreement_id;
}

function builder(table: string, serviceRole: boolean) {
  const filters: Array<[string, unknown]> = [];
  const inFilters: Array<[string, unknown[]]> = [];
  let op: QueryLog['op'] = 'select';
  let payload: Row | null = null;
  let limitN = Infinity;

  const value = (row: Row, column: string) =>
    column.includes('->') ? jsonPath(row, column) : row[column];

  const matches = () =>
    (db[table as keyof Db] ?? []).filter(
      (row) =>
        filters.every(([column, v]) => value(row, column) === v) &&
        inFilters.every(([column, vs]) =>
          vs.includes(value(row, column) as never)
        )
    );

  const record = () => {
    queries.push({
      table,
      op,
      filters: [
        ...filters,
        ...inFilters.map(([c, v]) => [c, v] as [string, unknown]),
      ],
      payload: payload ?? undefined,
      serviceRole,
    });
  };

  const result = () => {
    record();
    if (op === 'select' && selectFailure === table) {
      return { data: null, error: { code: '42501' } };
    }
    if (op === 'update') {
      if (updateFailure === table) {
        return { data: null, error: { code: '42501' } };
      }
      for (const row of matches()) Object.assign(row, payload);
      return { data: null, error: null };
    }
    return { data: matches().slice(0, limitN), error: null };
  };

  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = vi.fn(chain);
  b.order = vi.fn(chain);
  b.eq = vi.fn((column: string, v: unknown) => {
    filters.push([column, v]);
    return b;
  });
  b.in = vi.fn((column: string, vs: unknown[]) => {
    inFilters.push([column, vs]);
    return b;
  });
  b.limit = vi.fn((n: number) => {
    limitN = n;
    return b;
  });
  b.update = vi.fn((row: Row) => {
    op = 'update';
    payload = row;
    return b;
  });
  b.insert = vi.fn((row: Row) => {
    op = 'insert';
    payload = row;
    return b;
  });
  b.delete = vi.fn(() => {
    op = 'delete';
    return b;
  });
  b.maybeSingle = vi.fn(async () => {
    const res = result();
    if (res.error) return res;
    const rows = (res.data as Row[]) ?? [];
    return { data: rows[0] ?? null, error: null };
  });
  b.single = vi.fn(async () => {
    const res = result();
    if (res.error) return res;
    const rows = (res.data as Row[]) ?? [];
    return rows[0]
      ? { data: rows[0], error: null }
      : { data: null, error: { code: 'PGRST116' } };
  });
  b.then = (resolve: (value: unknown) => unknown) => resolve(result());
  return b;
}

function makeClient(serviceRole: boolean) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: currentUser } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table, serviceRole)),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeClient(false)),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => makeClient(true),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => makeClient(true),
}));

const paypal = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  activateSubscription: vi.fn(),
  reviseSubscription: vi.fn(),
}));

vi.mock('@/lib/billing/paypal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/billing/paypal')>(
    '@/lib/billing/paypal'
  );
  return { ...actual, ...paypal };
});

import { GET, POST } from './route';
import { PayPalError } from '@/lib/billing/paypal';

function post(body: unknown) {
  return POST(
    new Request('https://app.example.com/api/billing/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

function writesTo(table: string) {
  return queries.filter((q) => q.table === table && q.op !== 'select');
}

function subscriptionOf(accountId: string) {
  return db.subscriptions.find((r) => r.account_id === accountId)!;
}

beforeEach(() => {
  db = freshDb();
  queries = [];
  currentUser = 'user-a';
  selectFailure = null;
  updateFailure = null;
  paypal.cancelSubscription.mockReset().mockResolvedValue(undefined);
  paypal.activateSubscription.mockReset().mockResolvedValue(undefined);
  paypal.reviseSubscription
    .mockReset()
    .mockResolvedValue({ approvalUrl: null });
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GET /api/billing/subscription', () => {
  it('shows the consumption of usage_counters, unchanged', async () => {
    const json = await (await GET()).json();
    const byMetric = Object.fromEntries(
      json.usage.map((l: { metric: string }) => [l.metric, l])
    );
    expect(byMetric.messages_out.used).toBe(2731);
    expect(byMetric.messages_out.limit).toBe(15000);
    expect(byMetric.ai_replies.used).toBe(12);
    expect(byMetric.broadcast_recipients.used).toBe(0);
  });

  it('counts only the current period, never a previous one', async () => {
    const json = await (await GET()).json();
    const line = json.usage.find(
      (l: { metric: string }) => l.metric === 'messages_out'
    );
    // 99999 belongs to 2020-01. Summing periods would invent a number
    // the enforcement layer does not use.
    expect(line.used).toBe(2731);
    const usageQuery = queries.find((q) => q.table === 'usage_counters')!;
    expect(usageQuery.filters).toContainEqual(['period_start', PERIOD]);
  });

  it('reports plan, status, cycle and the next charge', async () => {
    const json = await (await GET()).json();
    expect(json.planId).toBe('pro');
    expect(json.planName).toBe('Pro');
    expect(json.status).toBe('active');
    expect(json.cycle).toBe('month');
    expect(json.nextChargeAt).toBe('2026-10-01T00:00:00Z');
    expect(json.actions).toEqual({
      cancel: true,
      reactivate: null,
      changePlan: 'revise',
    });
  });

  it('lists this account receipts and never another account (leak test)', async () => {
    const json = await (await GET()).json();
    expect(json.receipts.map((r: { id: string }) => r.id)).toEqual([
      'evt-a1',
      'evt-a2',
    ]);
    expect(JSON.stringify(json.receipts)).not.toContain('1990.00');
    const receiptQuery = queries.find((q) => q.table === 'billing_events')!;
    expect(receiptQuery.filters).toContainEqual([
      'payload->resource->>billing_agreement_id',
      ['I-SUB-A'],
    ]);
    expect(receiptQuery.filters).toContainEqual([
      'event_type',
      'PAYMENT.SALE.COMPLETED',
    ]);
  });

  it('scopes every tenant query by account_id (leak test)', async () => {
    await GET();
    for (const table of [
      'subscriptions',
      'usage_counters',
      'checkout_intents',
    ]) {
      const q = queries.find((x) => x.table === table)!;
      expect(q.filters).toContainEqual(['account_id', ACCOUNT_A]);
    }
  });

  it('never touches the gateway log when the account has no PayPal id', async () => {
    // The tenant scope of `billing_events` IS the id list. With no ids
    // the query must not run at all: a filterless read of that table
    // would be every tenant's payment history.
    db.subscriptions = [
      { ...subscriptionOf(ACCOUNT_A), provider_subscription_id: null },
    ];
    db.checkout_intents = [];
    const json = await (await GET()).json();
    expect(json.receipts).toEqual([]);
    expect(queries.some((q) => q.table === 'billing_events')).toBe(false);
  });

  it('includes the payments of a subscription that was cancelled and re-contracted', async () => {
    db.checkout_intents.push({
      id: 'intent-a0',
      account_id: ACCOUNT_A,
      plan_id: 'pro',
      cycle: 'month',
      provider: 'paypal',
      provider_plan_id: 'P-PRO-MONTH',
      provider_subscription_id: 'I-OLD-A',
      status: 'cancelled',
    });
    db.billing_events.push(
      sale('evt-a0', 'I-OLD-A', '79.00', '2026-06-01T10:00:00Z')
    );
    const json = await (await GET()).json();
    expect(json.receipts.map((r: { id: string }) => r.id)).toContain('evt-a0');
  });

  it('answers a suspended account — it is the one that needs the button', async () => {
    Object.assign(subscriptionOf(ACCOUNT_A), {
      status: 'suspended',
      cancel_at_period_end: false,
    });
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe('suspended');
    expect(json.readOnly).toBe(true);
    expect(json.actions.reactivate).toBe('activate');
    expect(json.actions.cancel).toBe(true);
  });

  it('refuses a caller below admin', async () => {
    currentUser = 'agent-a';
    expect((await GET()).status).toBe(403);
  });

  it('500s instead of pretending the account has no subscription', async () => {
    selectFailure = 'subscriptions';
    expect((await GET()).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST — cancel
// ---------------------------------------------------------------------------

describe('POST /api/billing/subscription — cancel', () => {
  it('cancels at PayPal and only flags the end of the cycle', async () => {
    const res = await post({ action: 'cancel' });
    expect(res.status).toBe(200);
    expect(paypal.cancelSubscription).toHaveBeenCalledWith(
      'I-SUB-A',
      expect.any(String)
    );

    const row = subscriptionOf(ACCOUNT_A);
    expect(row.cancel_at_period_end).toBe(true);
    // The status is the webhook's to change ("servicio hasta fin de
    // ciclo"), and the watermark belongs to the event stream: moving it
    // here would make PayPal's own CANCELLED look like a late delivery.
    expect(row.status).toBe('active');
    expect(row.last_event_at).toBe('2026-09-01T00:00:00Z');
    expect(row.current_period_end).toBe('2026-10-01T00:00:00Z');

    const writes = writesTo('subscriptions');
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].payload!)).toEqual(['cancel_at_period_end']);
  });

  it('never writes another account (leak test)', async () => {
    await post({ action: 'cancel' });
    for (const write of writesTo('subscriptions')) {
      expect(write.filters).toContainEqual(['account_id', ACCOUNT_A]);
    }
    expect(subscriptionOf(ACCOUNT_B).cancel_at_period_end).toBe(false);
  });

  it('accepts a subscription PayPal had already cancelled', async () => {
    paypal.cancelSubscription.mockRejectedValue(
      new PayPalError('already cancelled', 422, {})
    );
    const res = await post({ action: 'cancel' });
    expect(res.status).toBe(200);
    // Our intent matches the provider's state, so the flag is still set
    // instead of showing an error for something that is already done.
    expect(subscriptionOf(ACCOUNT_A).cancel_at_period_end).toBe(true);
  });

  it('502s and writes nothing when PayPal refuses', async () => {
    paypal.cancelSubscription.mockRejectedValue(
      new PayPalError('nope', 500, {})
    );
    const res = await post({ action: 'cancel' });
    expect(res.status).toBe(502);
    expect(writesTo('subscriptions')).toHaveLength(0);
    expect(subscriptionOf(ACCOUNT_A).cancel_at_period_end).toBe(false);
  });

  it('does not report failure when only the local flag could not be written', async () => {
    // PayPal already cancelled. Telling the customer "it failed" invites
    // a second attempt on a subscription that no longer exists; the
    // webhook sets the same flag when its event lands.
    updateFailure = 'subscriptions';
    const res = await post({ action: 'cancel' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('cancelled_at_provider');
  });

  it('409s when there is nothing to cancel', async () => {
    Object.assign(subscriptionOf(ACCOUNT_A), { status: 'cancelled' });
    const res = await post({ action: 'cancel' });
    expect(res.status).toBe(409);
    expect(paypal.cancelSubscription).not.toHaveBeenCalled();
  });

  it('does not cancel twice once the cancellation is scheduled', async () => {
    Object.assign(subscriptionOf(ACCOUNT_A), { cancel_at_period_end: true });
    expect((await post({ action: 'cancel' })).status).toBe(409);
    expect(paypal.cancelSubscription).not.toHaveBeenCalled();
  });

  it('lets a suspended account cancel — stopping the bill is the way out too', async () => {
    Object.assign(subscriptionOf(ACCOUNT_A), { status: 'suspended' });
    expect((await post({ action: 'cancel' })).status).toBe(200);
  });

  it('refuses a caller below admin', async () => {
    currentUser = 'agent-a';
    expect((await post({ action: 'cancel' })).status).toBe(403);
    expect(paypal.cancelSubscription).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST — reactivate
// ---------------------------------------------------------------------------

describe('POST /api/billing/subscription — reactivate', () => {
  it('asks PayPal to resume and writes absolutely nothing', async () => {
    Object.assign(subscriptionOf(ACCOUNT_A), { status: 'suspended' });
    const res = await post({ action: 'reactivate' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('reactivation_requested');
    expect(paypal.activateSubscription).toHaveBeenCalledWith(
      'I-SUB-A',
      expect.any(String)
    );
    // The acceptance criterion of the whole phase: only the webhook
    // turns a subscription back on.
    expect(writesTo('subscriptions')).toHaveLength(0);
    expect(subscriptionOf(ACCOUNT_A).status).toBe('suspended');
  });

  it('sends a cancelled subscription to the checkout instead', async () => {
    Object.assign(subscriptionOf(ACCOUNT_A), { status: 'cancelled' });
    const res = await post({ action: 'reactivate' });
    expect(res.status).toBe(409);
    expect((await res.json()).mode).toBe('checkout');
    expect(paypal.activateSubscription).not.toHaveBeenCalled();
  });

  it('does not try to resume a subscription that is already running', async () => {
    expect((await post({ action: 'reactivate' })).status).toBe(409);
    expect(paypal.activateSubscription).not.toHaveBeenCalled();
  });

  it('502s when PayPal refuses to resume', async () => {
    Object.assign(subscriptionOf(ACCOUNT_A), { status: 'suspended' });
    paypal.activateSubscription.mockRejectedValue(
      new PayPalError('nope', 422, {})
    );
    expect((await post({ action: 'reactivate' })).status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// POST — change plan
// ---------------------------------------------------------------------------

describe('POST /api/billing/subscription — change plan', () => {
  it('revises the same PayPal subscription, never opening a second one', async () => {
    const res = await post({
      action: 'change_plan',
      planId: 'negocio',
      cycle: 'month',
    });
    expect(res.status).toBe(200);
    expect(paypal.reviseSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'I-SUB-A',
        planId: 'P-NEG-MONTH',
      })
    );
    expect((await res.json()).status).toBe('change_requested');
  });

  it('writes no plan of its own — the UPDATED event reconciles it', async () => {
    await post({ action: 'change_plan', planId: 'negocio', cycle: 'month' });
    expect(writesTo('subscriptions')).toHaveLength(0);
    const row = subscriptionOf(ACCOUNT_A);
    expect(row.plan_id).toBe('pro');
    expect(row.cycle).toBe('month');
  });

  it('hands back the approval link when PayPal wants the buyer to approve', async () => {
    paypal.reviseSubscription.mockResolvedValue({
      approvalUrl: 'https://www.sandbox.paypal.com/approve/revise-1',
    });
    const json = await (
      await post({ action: 'change_plan', planId: 'negocio', cycle: 'month' })
    ).json();
    expect(json.status).toBe('approval_required');
    expect(json.approvalUrl).toContain('approve/revise-1');
    expect(writesTo('subscriptions')).toHaveLength(0);
  });

  it('can move the billing cycle of the very same plan', async () => {
    const res = await post({
      action: 'change_plan',
      planId: 'pro',
      cycle: 'year',
    });
    expect(res.status).toBe(200);
    expect(paypal.reviseSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'P-PRO-YEAR' })
    );
  });

  it('refuses the plan and cycle already in force', async () => {
    const res = await post({
      action: 'change_plan',
      planId: 'pro',
      cycle: 'month',
    });
    expect(res.status).toBe(409);
    expect(paypal.reviseSubscription).not.toHaveBeenCalled();
  });

  it('refuses the plan in force even when the cycle column is NULL', async () => {
    // Migration 056 could not backfill every row: `cycle` stays NULL
    // wherever no checkout intent with a cycle matched. Comparing
    // through that column (`null === 'month'` is false) let a `revise`
    // onto the plan already in force through, and PayPal may answer
    // that with an approval link — sending the customer off to approve
    // what they already have. The PayPal plan id decides instead, and
    // the intent of migration 048 is where it lives.
    Object.assign(subscriptionOf(ACCOUNT_A), { cycle: null });

    const res = await post({
      action: 'change_plan',
      planId: 'pro',
      cycle: 'month',
    });

    expect(res.status).toBe(409);
    expect(paypal.reviseSubscription).not.toHaveBeenCalled();
    // The intent it reads for that is scoped to the caller's account.
    const reads = queries.filter((q) => q.table === 'checkout_intents');
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) {
      expect(q.filters).toContainEqual(['account_id', ACCOUNT_A]);
    }
  });

  it('still lets a NULL cycle move to the other cycle of the same plan', async () => {
    // The guard must not turn into "a row with no cycle can never
    // change plan": that is a real change and PayPal has a plan for it.
    Object.assign(subscriptionOf(ACCOUNT_A), { cycle: null });

    const res = await post({
      action: 'change_plan',
      planId: 'pro',
      cycle: 'year',
    });

    expect(res.status).toBe(200);
    expect(paypal.reviseSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'P-PRO-YEAR' })
    );
  });

  it('lets the change through when nothing records the plan in force', async () => {
    // No cycle and no intent: we do not know what PayPal is charging,
    // and refusing a change on a guess would strand the customer on a
    // plan they cannot leave from here.
    Object.assign(subscriptionOf(ACCOUNT_A), { cycle: null });
    db.checkout_intents = db.checkout_intents.filter(
      (row) => row.account_id !== ACCOUNT_A
    );

    const res = await post({
      action: 'change_plan',
      planId: 'pro',
      cycle: 'month',
    });

    expect(res.status).toBe(200);
    expect(paypal.reviseSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'P-PRO-MONTH' })
    );
  });

  it('sends an account with nothing being charged to the checkout', async () => {
    Object.assign(subscriptionOf(ACCOUNT_A), {
      status: 'trialing',
      provider_subscription_id: null,
    });
    const res = await post({
      action: 'change_plan',
      planId: 'negocio',
      cycle: 'month',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).mode).toBe('checkout');
    expect(paypal.reviseSubscription).not.toHaveBeenCalled();
  });

  it('refuses a plan that is not on sale and a cycle PayPal has no plan for', async () => {
    expect(
      (await post({ action: 'change_plan', planId: 'oculto', cycle: 'month' }))
        .status
    ).toBe(404);
    expect(
      (await post({ action: 'change_plan', planId: 'negocio', cycle: 'year' }))
        .status
    ).toBe(409);
    expect(paypal.reviseSubscription).not.toHaveBeenCalled();
  });

  it('validates the body before touching PayPal', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ action: 'nope' })).status).toBe(400);
    expect((await post({ action: 'change_plan', cycle: 'month' })).status).toBe(
      400
    );
    expect(
      (await post({ action: 'change_plan', planId: 'negocio', cycle: 'week' }))
        .status
    ).toBe(400);
    expect(paypal.reviseSubscription).not.toHaveBeenCalled();
  });

  it('502s when PayPal refuses the revision', async () => {
    paypal.reviseSubscription.mockRejectedValue(
      new PayPalError('nope', 422, {})
    );
    const res = await post({
      action: 'change_plan',
      planId: 'negocio',
      cycle: 'month',
    });
    expect(res.status).toBe(502);
    expect(writesTo('subscriptions')).toHaveLength(0);
  });

  it('ignores an account_id the caller tries to supply', async () => {
    await POST(
      new Request('https://app.example.com/api/billing/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'change_plan',
          planId: 'negocio',
          cycle: 'month',
          account_id: ACCOUNT_B,
          accountId: ACCOUNT_B,
        }),
      })
    );
    expect(paypal.reviseSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'I-SUB-A' })
    );
    for (const q of queries.filter((x) => x.table === 'subscriptions')) {
      expect(q.filters).toContainEqual(['account_id', ACCOUNT_A]);
    }
  });
});
