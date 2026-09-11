import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The PayPal webhook of Fase 3 §3. This is the only thing in the product
// that turns a payment into service, so the tests below are about the
// four properties that make that safe rather than about happy paths:
//
//   1. An unverified delivery changes nothing.
//   2. The same event delivered twice is processed once.
//   3. Every service-role write is scoped to the account the event
//      resolves to — from OUR rows, never from the event.
//   4. An event that arrives out of order cannot undo a newer one.
//
// The Supabase mock is an in-memory store that really honours `.eq()`
// filters and the two UNIQUE constraints that matter (migration 041's
// `billing_events (provider, provider_event_id)` and 048's
// `checkout_intents (provider, provider_subscription_id)`), plus the
// primary key of `subscriptions`. A leak test therefore fails when the
// filter is missing, not when the mock is edited.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Db {
  plans: Row[];
  subscriptions: Row[];
  checkout_intents: Row[];
  billing_events: Row[];
}

interface QueryLog {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  filters: Array<[string, unknown]>;
  payload?: Row;
}

const ACCOUNT_A = 'acct-a';
const ACCOUNT_B = 'acct-b';

let db: Db;
let queries: QueryLog[];
/** Tables whose next write comes back as a transient failure. */
let writeFailure: { table: keyof Db; op: 'insert' | 'update' } | null;

function freshDb(): Db {
  return {
    plans: [
      {
        id: 'pro',
        name: 'Pro',
        provider_plan_id_month: 'P-PRO-MONTH',
        provider_plan_id_year: 'P-PRO-YEAR',
      },
      {
        id: 'negocio',
        name: 'Negocio',
        provider_plan_id_month: 'P-NEGOCIO-MONTH',
        provider_plan_id_year: 'P-NEGOCIO-YEAR',
      },
    ],
    subscriptions: [],
    checkout_intents: [],
    billing_events: [],
  };
}

/** An approved checkout waiting for its event, as §2 leaves it. */
function intent(accountId: string, subscriptionId: string, over: Row = {}) {
  return {
    id: `intent-${subscriptionId}`,
    account_id: accountId,
    plan_id: 'pro',
    cycle: 'month',
    provider: 'paypal',
    provider_plan_id: 'P-PRO-MONTH',
    provider_subscription_id: subscriptionId,
    status: 'pending',
    ...over,
  };
}

function subscriptionRow(accountId: string, over: Row = {}) {
  return {
    account_id: accountId,
    plan_id: 'pro',
    provider: 'paypal',
    provider_subscription_id: `I-${accountId}`,
    status: 'active',
    current_period_end: '2026-04-15T12:00:00.000Z',
    grace_until: null,
    cancel_at_period_end: false,
    addons: {},
    last_event_at: '2026-03-15T12:00:00.000Z',
    ...over,
  };
}

/** UNIQUE / primary-key constraints the real schema enforces. */
function constraintViolation(table: string, row: Row): boolean {
  const rows = db[table as keyof Db] ?? [];
  if (table === 'billing_events') {
    return rows.some(
      (r) =>
        r.provider === row.provider &&
        r.provider_event_id === row.provider_event_id
    );
  }
  if (table === 'subscriptions') {
    return rows.some(
      (r) =>
        r.account_id === row.account_id ||
        (row.provider_subscription_id != null &&
          r.provider_subscription_id === row.provider_subscription_id)
    );
  }
  if (table === 'checkout_intents') {
    return rows.some(
      (r) =>
        r.provider === row.provider &&
        r.provider_subscription_id === row.provider_subscription_id
    );
  }
  return false;
}

function builder(table: string) {
  const filters: Array<[string, unknown]> = [];
  let op: QueryLog['op'] = 'select';
  let payload: Row | null = null;

  const matches = () =>
    (db[table as keyof Db] ?? []).filter((row) =>
      filters.every(([column, value]) => row[column] === value)
    );

  const result = () => {
    queries.push({
      table,
      op,
      filters: [...filters],
      payload: payload ?? undefined,
    });

    if (
      writeFailure &&
      writeFailure.table === table &&
      writeFailure.op === op
    ) {
      writeFailure = null;
      return { data: null, error: { code: '08006', message: 'connection' } };
    }

    if (op === 'insert') {
      const row = { ...(payload as Row) };
      if (constraintViolation(table, row)) {
        return { data: null, error: { code: '23505' } };
      }
      (db[table as keyof Db] as Row[]).push(row);
      return { data: row, error: null };
    }
    if (op === 'update') {
      const hit = matches();
      for (const row of hit) Object.assign(row, payload);
      return { data: hit, error: null };
    }
    if (op === 'delete') {
      const hit = new Set(matches());
      db[table as keyof Db] = (db[table as keyof Db] as Row[]).filter(
        (row) => !hit.has(row)
      );
      return { data: null, error: null };
    }
    return { data: matches(), error: null };
  };

  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = vi.fn(chain);
  b.order = vi.fn(chain);
  b.limit = vi.fn(chain);
  b.eq = vi.fn((column: string, value: unknown) => {
    filters.push([column, value]);
    return b;
  });
  b.insert = vi.fn((row: Row) => {
    op = 'insert';
    payload = row;
    return b;
  });
  b.update = vi.fn((row: Row) => {
    op = 'update';
    payload = row;
    return b;
  });
  b.delete = vi.fn(() => {
    op = 'delete';
    return b;
  });
  b.maybeSingle = vi.fn(async () => {
    const res = result();
    if (res.error || op !== 'select') return res;
    const rows = res.data as Row[];
    return { data: rows[0] ?? null, error: null };
  });
  b.single = b.maybeSingle;
  b.then = (resolve: (value: unknown) => unknown) => resolve(result());
  return b;
}

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: vi.fn((table: string) => builder(table)) }),
}));

const { verifyPayPalWebhook } = vi.hoisted(() => ({
  verifyPayPalWebhook: vi.fn<(raw: string, h: Headers) => Promise<boolean>>(),
}));

vi.mock('@/lib/billing/paypal-webhook-signature', () => ({
  verifyPayPalWebhook,
}));

import { POST } from './route';

/** Post a body exactly as PayPal would, bytes and all. */
function postRaw(rawBody: string) {
  return POST(
    new Request('https://app.example.com/api/billing/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    })
  );
}

function post(event: Row) {
  return postRaw(JSON.stringify(event));
}

function activated(
  subscriptionId: string,
  over: Row = {},
  resource: Row = {}
): Row {
  return {
    id: `WH-${subscriptionId}-activated`,
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    create_time: '2026-03-15T12:00:00Z',
    resource: {
      id: subscriptionId,
      status: 'ACTIVE',
      billing_info: { next_billing_time: '2026-04-15T12:00:00Z' },
      ...resource,
    },
    ...over,
  };
}

/** Writes recorded against a table. */
function writesTo(table: string) {
  return queries.filter((q) => q.table === table && q.op !== 'select');
}

/** The account every write on a tenant table was scoped to. */
function scopesOf(table: string): Array<unknown> {
  return writesTo(table).map((q) => {
    const filter = q.filters.find(([column]) => column === 'account_id');
    if (filter) return filter[1];
    return q.payload?.account_id;
  });
}

function accountOf(accountId: string) {
  return db.subscriptions.find((row) => row.account_id === accountId) ?? null;
}

beforeEach(() => {
  // Fixed clock: whether a cancellation still has a paid cycle left to
  // serve is a comparison against `now`, and that must not depend on
  // the day the suite runs.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-20T00:00:00.000Z'));
  db = freshDb();
  queries = [];
  writeFailure = null;
  verifyPayPalWebhook.mockReset();
  verifyPayPalWebhook.mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('signature', () => {
  it('rejects a delivery with an invalid signature and writes nothing', async () => {
    verifyPayPalWebhook.mockResolvedValue(false);
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1'));

    const res = await post(activated('I-1'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    // Not even the audit row: an unverified body is not an event.
    expect(queries).toHaveLength(0);
    expect(db.subscriptions).toHaveLength(0);
    expect(db.billing_events).toHaveLength(0);
  });

  it('verifies the raw bytes, before any parsing', async () => {
    // Spacing and key order that JSON.stringify would not reproduce.
    const rawBody =
      '{ "id":"WH-RAW",\n  "event_type":"BILLING.SUBSCRIPTION.SUSPENDED",\n' +
      '  "resource": { "id":"I-1" } }';
    db.subscriptions.push(
      subscriptionRow(ACCOUNT_A, {
        provider_subscription_id: 'I-1',
        last_event_at: null,
      })
    );

    await postRaw(rawBody);

    expect(verifyPayPalWebhook).toHaveBeenCalledTimes(1);
    expect(verifyPayPalWebhook.mock.calls[0][0]).toBe(rawBody);
  });

  it('refuses a body that is not JSON, or not an event', async () => {
    expect((await postRaw('not json')).status).toBe(400);
    expect(
      (await post({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED' })).status
    ).toBe(400);
    expect(db.billing_events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('idempotence', () => {
  it('processes the same event only once, however often PayPal sends it', async () => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1'));

    const first = await post(activated('I-1'));
    const second = await post(activated('I-1'));
    const third = await post(activated('I-1'));

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'processed' });
    expect(await second.json()).toEqual({ status: 'duplicate' });
    expect(await third.json()).toEqual({ status: 'duplicate' });

    expect(db.billing_events).toHaveLength(1);
    // One activation, one write. The replays touched nothing.
    expect(writesTo('subscriptions')).toHaveLength(1);
    expect(db.subscriptions).toHaveLength(1);
  });

  it('records the event before processing it', async () => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1'));

    await post(activated('I-1'));

    const order = queries.filter((q) => q.op !== 'select').map((q) => q.table);
    expect(order[0]).toBe('billing_events');
    expect(order).toContain('subscriptions');
    expect(order.indexOf('billing_events')).toBeLessThan(
      order.indexOf('subscriptions')
    );
  });

  it('does not process when the event cannot be recorded', async () => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1'));
    writeFailure = { table: 'billing_events', op: 'insert' };

    const res = await post(activated('I-1'));

    expect(res.status).toBe(500);
    expect(db.subscriptions).toHaveLength(0);
    expect(writesTo('subscriptions')).toHaveLength(0);
  });

  it('releases the lock when a write fails, so the redelivery is a real retry', async () => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1'));
    writeFailure = { table: 'subscriptions', op: 'insert' };

    const failed = await post(activated('I-1'));
    expect(failed.status).toBe(500);
    // Lock released: nothing was applied, so the event must be able to
    // come back rather than be answered "already processed" forever.
    expect(db.billing_events).toHaveLength(0);

    const retry = await post(activated('I-1'));
    expect(await retry.json()).toMatchObject({ status: 'processed' });
    expect(accountOf(ACCOUNT_A)).toMatchObject({ status: 'active' });
  });
});

// ---------------------------------------------------------------------------
describe('activation', () => {
  it('activates the plan when the customer closed the browser after approving', async () => {
    // §2 recorded the intent and the customer never came back.
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1'));

    const res = await post(activated('I-1'));

    expect(res.status).toBe(200);
    expect(accountOf(ACCOUNT_A)).toMatchObject({
      account_id: ACCOUNT_A,
      plan_id: 'pro',
      status: 'active',
      provider_subscription_id: 'I-1',
      current_period_end: '2026-04-15T12:00:00.000Z',
      cancel_at_period_end: false,
      last_event_at: '2026-03-15T12:00:00.000Z',
    });
    // And the attempt of §2 stops being pending.
    expect(db.checkout_intents[0].status).toBe('activated');
  });

  it('updates the trialing row instead of inserting a second one', async () => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1'));
    db.subscriptions.push(
      subscriptionRow(ACCOUNT_A, {
        status: 'trialing',
        provider_subscription_id: null,
        current_period_end: null,
        last_event_at: null,
      })
    );

    const res = await post(activated('I-1'));

    expect(await res.json()).toMatchObject({ status: 'processed' });
    expect(db.subscriptions).toHaveLength(1);
    expect(accountOf(ACCOUNT_A)).toMatchObject({
      status: 'active',
      provider_subscription_id: 'I-1',
    });
  });

  it('marks the event processed with no error', async () => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1'));

    await post(activated('I-1'));

    expect(db.billing_events[0]).toMatchObject({
      provider: 'paypal',
      provider_event_id: 'WH-I-1-activated',
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      error: null,
    });
    expect(db.billing_events[0].processed_at).toEqual(expect.any(String));
  });
});

// ---------------------------------------------------------------------------
describe('tenant isolation', () => {
  it('never writes to another account than the one the subscription belongs to', async () => {
    db.checkout_intents.push(intent(ACCOUNT_B, 'I-B'));
    db.subscriptions.push(
      subscriptionRow(ACCOUNT_A, { provider_subscription_id: 'I-A' })
    );

    await post(activated('I-B'));

    // Account A, which was here first, is untouched.
    expect(accountOf(ACCOUNT_A)).toMatchObject({
      provider_subscription_id: 'I-A',
      status: 'active',
      last_event_at: '2026-03-15T12:00:00.000Z',
    });
    expect(accountOf(ACCOUNT_B)).toMatchObject({ status: 'active' });

    // Every write on a tenant table carried account B and nothing else.
    expect(scopesOf('subscriptions')).toEqual([ACCOUNT_B]);
    expect(scopesOf('checkout_intents')).toEqual([ACCOUNT_B]);
  });

  it('ignores an account id the event tries to supply', async () => {
    db.checkout_intents.push(intent(ACCOUNT_B, 'I-B'));

    // A `custom_id` naming someone else must not redirect the write…
    const res = await post(activated('I-B', {}, { custom_id: ACCOUNT_A }));

    expect(await res.json()).toMatchObject({ status: 'unmatched' });
    expect(db.subscriptions).toHaveLength(0);
    expect(writesTo('subscriptions')).toHaveLength(0);
    expect(db.billing_events[0].processed_at).toBeNull();
    expect(String(db.billing_events[0].error)).toContain('custom_id');
  });

  it('accepts the custom_id that agrees with our own record', async () => {
    db.checkout_intents.push(intent(ACCOUNT_B, 'I-B'));

    const res = await post(activated('I-B', {}, { custom_id: ACCOUNT_B }));

    expect(await res.json()).toMatchObject({ status: 'processed' });
    expect(accountOf(ACCOUNT_B)).toMatchObject({ status: 'active' });
  });

  it('refuses an event for a subscription no account of ours owns', async () => {
    const res = await post(activated('I-GHOST'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'unmatched' });
    expect(db.subscriptions).toHaveLength(0);
    // Kept for reconciliation: unprocessed, with the reason.
    expect(db.billing_events[0]).toMatchObject({ processed_at: null });
    expect(String(db.billing_events[0].error)).toContain('I-GHOST');
  });

  it('refuses when our own two records disagree about the owner', async () => {
    db.checkout_intents.push(intent(ACCOUNT_B, 'I-1'));
    db.subscriptions.push(
      subscriptionRow(ACCOUNT_A, { provider_subscription_id: 'I-1' })
    );

    const res = await post(activated('I-1'));

    expect(await res.json()).toMatchObject({ status: 'unmatched' });
    expect(writesTo('subscriptions')).toHaveLength(0);
  });

  it('does not let another subscription rewrite an account already on one', async () => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-OTHER'));
    db.subscriptions.push(
      subscriptionRow(ACCOUNT_A, {
        provider_subscription_id: 'I-1',
        plan_id: 'negocio',
      })
    );

    const res = await post(activated('I-OTHER'));

    expect(await res.json()).toMatchObject({ status: 'unmatched' });
    expect(accountOf(ACCOUNT_A)).toMatchObject({
      provider_subscription_id: 'I-1',
      plan_id: 'negocio',
    });
  });
});

// ---------------------------------------------------------------------------
describe('the other five events', () => {
  beforeEach(() => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1', { status: 'activated' }));
    db.subscriptions.push(
      subscriptionRow(ACCOUNT_A, { provider_subscription_id: 'I-1' })
    );
  });

  it('cancels at the end of the paid cycle', async () => {
    const res = await post({
      id: 'WH-cancel',
      event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
      create_time: '2026-03-20T00:00:00Z',
      resource: { id: 'I-1', status: 'CANCELLED' },
    });

    expect(await res.json()).toMatchObject({ status: 'processed' });
    expect(accountOf(ACCOUNT_A)).toMatchObject({
      cancel_at_period_end: true,
      // Still served: they paid to 15 April.
      status: 'active',
      current_period_end: '2026-04-15T12:00:00.000Z',
    });
    expect(db.checkout_intents[0].status).toBe('cancelled');
  });

  it('suspends', async () => {
    await post({
      id: 'WH-suspend',
      event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
      create_time: '2026-03-20T00:00:00Z',
      resource: { id: 'I-1' },
    });

    expect(accountOf(ACCOUNT_A)).toMatchObject({ status: 'suspended' });
  });

  it('opens a seven-day grace window on a failed payment', async () => {
    await post({
      id: 'WH-failed',
      event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      create_time: '2026-03-20T00:00:00Z',
      resource: { id: 'I-1' },
    });

    expect(accountOf(ACCOUNT_A)).toMatchObject({
      status: 'past_due',
      grace_until: '2026-03-27T00:00:00.000Z',
    });
  });

  it('renews on a completed sale and comes back from past_due', async () => {
    Object.assign(db.subscriptions[0], {
      status: 'past_due',
      grace_until: '2026-04-22T00:00:00.000Z',
    });

    await post({
      id: 'WH-sale',
      event_type: 'PAYMENT.SALE.COMPLETED',
      create_time: '2026-04-15T12:00:00Z',
      resource: { id: 'SALE-1', billing_agreement_id: 'I-1' },
    });

    expect(accountOf(ACCOUNT_A)).toMatchObject({
      status: 'active',
      grace_until: null,
      current_period_end: '2026-05-15T12:00:00.000Z',
    });
  });

  it('reconciles the plan an update reports, through our own catalogue', async () => {
    await post({
      id: 'WH-updated',
      event_type: 'BILLING.SUBSCRIPTION.UPDATED',
      create_time: '2026-03-20T00:00:00Z',
      resource: {
        id: 'I-1',
        status: 'ACTIVE',
        plan_id: 'P-NEGOCIO-YEAR',
        quantity: '1',
        billing_info: { next_billing_time: '2027-03-20T00:00:00Z' },
      },
    });

    expect(accountOf(ACCOUNT_A)).toMatchObject({
      plan_id: 'negocio',
      current_period_end: '2027-03-20T00:00:00.000Z',
    });
  });

  it('refuses an update naming a PayPal plan our catalogue does not have', async () => {
    const res = await post({
      id: 'WH-updated-unknown',
      event_type: 'BILLING.SUBSCRIPTION.UPDATED',
      create_time: '2026-03-20T00:00:00Z',
      resource: { id: 'I-1', plan_id: 'P-SOMETHING-ELSE' },
    });

    expect(await res.json()).toMatchObject({ status: 'unmatched' });
    expect(accountOf(ACCOUNT_A)).toMatchObject({ plan_id: 'pro' });
  });

  it('stores an event outside the spec table and acknowledges it', async () => {
    const res = await post({
      id: 'WH-refund',
      event_type: 'PAYMENT.SALE.REFUNDED',
      create_time: '2026-03-20T00:00:00Z',
      resource: { id: 'SALE-1', billing_agreement_id: 'I-1' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'skipped' });
    expect(db.billing_events[0].event_type).toBe('PAYMENT.SALE.REFUNDED');
    expect(writesTo('subscriptions')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('events out of order', () => {
  it('does not resurrect a cancelled subscription with a late activation', async () => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1', { status: 'cancelled' }));
    db.subscriptions.push(
      subscriptionRow(ACCOUNT_A, {
        provider_subscription_id: 'I-1',
        status: 'cancelled',
        current_period_end: '2026-03-10T00:00:00.000Z',
        last_event_at: '2026-03-10T00:00:00.000Z',
      })
    );

    // Stamped before the cancellation, delivered after it.
    await post(activated('I-1', { create_time: '2026-03-01T00:00:00Z' }));

    const row = accountOf(ACCOUNT_A)!;
    expect(row.status).toBe('cancelled');
    // Only the period may move, and only forward.
    expect(row.current_period_end).toBe('2026-04-15T12:00:00.000Z');
    expect(row.last_event_at).toBe('2026-03-10T00:00:00.000Z');
    // And it does not drag the checkout attempt back to 'activated'.
    expect(db.checkout_intents[0].status).toBe('cancelled');
  });

  it('serves a customer whose payment arrives before the activation', async () => {
    db.checkout_intents.push(intent(ACCOUNT_A, 'I-1'));

    await post({
      id: 'WH-sale-first',
      event_type: 'PAYMENT.SALE.COMPLETED',
      create_time: '2026-03-15T12:00:00Z',
      resource: { id: 'SALE-1', billing_agreement_id: 'I-1' },
    });

    expect(accountOf(ACCOUNT_A)).toMatchObject({
      status: 'active',
      plan_id: 'pro',
      provider_subscription_id: 'I-1',
      current_period_end: '2026-04-15T12:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
describe('surface', () => {
  it('exposes only POST', async () => {
    const mod = await import('./route');
    expect(Object.keys(mod).sort()).toEqual(['POST']);
  });
});
