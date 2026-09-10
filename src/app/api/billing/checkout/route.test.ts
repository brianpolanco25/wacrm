import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for the checkout of Fase 3 §2. Two properties matter more than the
// happy path:
//
//   1. Nothing here activates a subscription. The customer coming back from
//      PayPal — or hitting the URL by hand — cannot change `subscriptions`.
//   2. Every service-role query is scoped to the caller's account. The
//      service-role client bypasses RLS, so a missing filter is a
//      cross-tenant leak, and `checkout_intents` is precisely the table
//      that says "this PayPal subscription belongs to that account".
//
// The Supabase mock below is an in-memory store that really honours `.eq()`
// filters (and the UNIQUE on the provider subscription id), so a leak test
// fails when the filter is missing instead of when the mock is edited.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Db {
  profiles: Row[];
  accounts: Row[];
  plans: Row[];
  subscriptions: Row[];
  checkout_intents: Row[];
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

let db: Db;
let queries: QueryLog[];
let currentUser: string;
let insertFailure: { code: string } | null;

function freshDb(): Db {
  return {
    profiles: [
      { user_id: 'user-a', account_id: ACCOUNT_A, account_role: 'admin' },
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
        sort_order: 2,
        limits: { operators: 10 },
        price_usd_month: '79.00',
        price_usd_year: '790.00',
        provider_plan_id_month: 'P-PRO-MONTH',
        provider_plan_id_year: 'P-PRO-YEAR',
      },
      {
        id: 'inicio',
        name: 'Inicio',
        is_public: true,
        sort_order: 1,
        limits: { operators: 3 },
        price_usd_month: '29.00',
        price_usd_year: '290.00',
        provider_plan_id_month: 'P-INICIO-MONTH',
        // Yearly not created in PayPal yet.
        provider_plan_id_year: null,
      },
      {
        id: 'oculto',
        name: 'Hidden',
        is_public: false,
        sort_order: 9,
        limits: {},
        price_usd_month: '9.00',
        price_usd_year: null,
        provider_plan_id_month: 'P-HIDDEN-MONTH',
        provider_plan_id_year: null,
      },
    ],
    subscriptions: [],
    checkout_intents: [],
  };
}

function builder(table: string, serviceRole: boolean) {
  const filters: Array<[string, unknown]> = [];
  let op: QueryLog['op'] = 'select';
  let payload: Row | null = null;
  let limitN = Infinity;

  const matches = () =>
    (db[table as keyof Db] ?? []).filter((row) =>
      filters.every(([column, value]) => row[column] === value)
    );

  const record = () => {
    queries.push({
      table,
      op,
      filters: [...filters],
      payload: payload ?? undefined,
      serviceRole,
    });
  };

  const result = () => {
    record();
    if (op === 'insert') {
      if (insertFailure) return { data: null, error: insertFailure };
      const row = payload as Row;
      const clash = (db[table as keyof Db] ?? []).some(
        (existing) =>
          existing.provider === row.provider &&
          existing.provider_subscription_id === row.provider_subscription_id
      );
      if (clash) {
        // UNIQUE (provider, provider_subscription_id) from migration 048.
        return { data: null, error: { code: '23505' } };
      }
      const stored = {
        id: `intent-${(db[table as keyof Db] ?? []).length + 1}`,
        created_at: new Date(1_700_000_000_000).toISOString(),
        ...row,
      };
      (db[table as keyof Db] as Row[]).push(stored);
      return { data: stored, error: null };
    }
    return { data: matches().slice(0, limitN), error: null };
  };

  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = vi.fn(chain);
  b.order = vi.fn(chain);
  b.eq = vi.fn((column: string, value: unknown) => {
    filters.push([column, value]);
    return b;
  });
  b.limit = vi.fn((n: number) => {
    limitN = n;
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
  b.upsert = vi.fn((row: Row) => {
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
    if (op === 'insert') return res;
    const rows = res.data as Row[];
    return { data: rows[0] ?? null, error: null };
  });
  b.single = vi.fn(async () => {
    const res = result();
    if (op === 'insert') return res;
    const rows = res.data as Row[];
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

interface CreateSubscriptionCall {
  planId: string;
  customId: string;
  returnUrl: string;
  cancelUrl: string;
  brandName?: string;
  requestId: string;
}

const { createSubscription } = vi.hoisted(() => ({
  createSubscription: vi.fn<
    (args: CreateSubscriptionCall) => Promise<{
      id: string;
      status: string;
      approvalUrl: string;
    }>
  >(),
}));

vi.mock('@/lib/billing/paypal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/billing/paypal')>(
    '@/lib/billing/paypal'
  );
  return { ...actual, createSubscription };
});

import * as route from './route';
import { PayPalError } from '@/lib/billing/paypal';

const { GET, POST } = route;

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('https://app.example.com/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );
}

function get(query = '') {
  return GET(
    new Request(`https://app.example.com/api/billing/checkout${query}`)
  );
}

/** Writes recorded against a table, whatever the client. */
function writesTo(table: string) {
  return queries.filter((q) => q.table === table && q.op !== 'select');
}

beforeEach(() => {
  db = freshDb();
  queries = [];
  currentUser = 'user-a';
  insertFailure = null;
  createSubscription.mockReset();
  createSubscription.mockResolvedValue({
    id: 'I-SUB-1',
    status: 'APPROVAL_PENDING',
    approvalUrl: 'https://www.sandbox.paypal.com/approve/1',
  });
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.com');
});

describe('POST /api/billing/checkout', () => {
  it('creates the PayPal subscription and hands back its approval link', async () => {
    const res = await post({ planId: 'pro', cycle: 'year' });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).toMatchObject({
      approvalUrl: 'https://www.sandbox.paypal.com/approve/1',
      subscriptionId: 'I-SUB-1',
      planId: 'pro',
      cycle: 'year',
    });

    expect(createSubscription).toHaveBeenCalledTimes(1);
    expect(createSubscription.mock.calls[0][0]).toMatchObject({
      planId: 'P-PRO-YEAR',
      customId: ACCOUNT_A,
      returnUrl: 'https://app.example.com/billing/return',
      cancelUrl: 'https://app.example.com/billing?checkout=cancelled',
    });
  });

  it('records the intent so the webhook can match the event to a tenant', async () => {
    await post({ planId: 'pro', cycle: 'month' });

    expect(db.checkout_intents).toHaveLength(1);
    expect(db.checkout_intents[0]).toMatchObject({
      account_id: ACCOUNT_A,
      plan_id: 'pro',
      cycle: 'month',
      provider: 'paypal',
      provider_plan_id: 'P-PRO-MONTH',
      provider_subscription_id: 'I-SUB-1',
      created_by: 'user-a',
      status: 'pending',
    });
  });

  it('does not touch subscriptions — only the webhook activates', async () => {
    await post({ planId: 'pro', cycle: 'month' });

    expect(writesTo('subscriptions')).toEqual([]);
    // And the intent is not an activation either.
    expect(db.checkout_intents[0].status).toBe('pending');
  });

  it('ignores an account_id supplied by the caller', async () => {
    // The body is attacker-controlled; the row must carry the account
    // of the authenticated context and nothing else.
    await post({
      planId: 'pro',
      cycle: 'month',
      accountId: ACCOUNT_B,
      account_id: ACCOUNT_B,
    });

    expect(db.checkout_intents[0].account_id).toBe(ACCOUNT_A);
    expect(createSubscription.mock.calls[0][0].customId).toBe(ACCOUNT_A);
  });

  it('keeps two accounts checking out at once apart', async () => {
    await post({ planId: 'pro', cycle: 'month' });

    currentUser = 'user-b';
    createSubscription.mockResolvedValue({
      id: 'I-SUB-2',
      status: 'APPROVAL_PENDING',
      approvalUrl: 'https://www.sandbox.paypal.com/approve/2',
    });
    const res = await post({ planId: 'inicio', cycle: 'month' });
    expect(res.status).toBe(201);

    expect(db.checkout_intents).toHaveLength(2);
    expect(db.checkout_intents.map((r) => [r.account_id, r.plan_id])).toEqual([
      [ACCOUNT_A, 'pro'],
      [ACCOUNT_B, 'inicio'],
    ]);
    // Nothing the second account wrote refers to the first.
    const bWrites = writesTo('checkout_intents').filter(
      (q) => q.payload?.account_id === ACCOUNT_B
    );
    expect(bWrites).toHaveLength(1);
  });

  it('refuses a caller below admin', async () => {
    db.profiles[0].account_role = 'agent';

    const res = await post({ planId: 'pro', cycle: 'month' });
    expect(res.status).toBe(403);
    expect(createSubscription).not.toHaveBeenCalled();
    expect(db.checkout_intents).toHaveLength(0);
  });

  it('400s on a missing plan or an unknown cycle', async () => {
    expect((await post({ cycle: 'month' })).status).toBe(400);
    expect((await post({ planId: 'pro', cycle: 'week' })).status).toBe(400);
    expect((await post({ planId: 'pro' })).status).toBe(400);
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it('404s on an unknown or non-public plan', async () => {
    expect((await post({ planId: 'nope', cycle: 'month' })).status).toBe(404);
    expect((await post({ planId: 'oculto', cycle: 'month' })).status).toBe(404);
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it('409s when the catalogue has no PayPal plan for that cycle', async () => {
    const res = await post({ planId: 'inicio', cycle: 'year' });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/not available/i);
    expect(createSubscription).not.toHaveBeenCalled();
    expect(db.checkout_intents).toHaveLength(0);
  });

  it('409s instead of opening a second paid subscription', async () => {
    db.subscriptions.push({
      account_id: ACCOUNT_A,
      plan_id: 'inicio',
      status: 'active',
      provider_subscription_id: 'I-OLD',
      current_period_end: null,
      cancel_at_period_end: false,
    });

    const res = await post({ planId: 'pro', cycle: 'month' });
    expect(res.status).toBe(409);
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it('lets a trialing account contract', async () => {
    db.subscriptions.push({
      account_id: ACCOUNT_A,
      plan_id: 'inicio',
      status: 'trialing',
      provider_subscription_id: null,
      current_period_end: null,
      cancel_at_period_end: false,
    });

    const res = await post({ planId: 'pro', cycle: 'month' });
    expect(res.status).toBe(201);
  });

  it('reuses the intent when PayPal replays a subscription we already stored', async () => {
    await post({ planId: 'pro', cycle: 'month' });
    // Same PayPal-Request-Id window → PayPal replays subscription I-SUB-1.
    const res = await post({ planId: 'pro', cycle: 'month' });

    expect(res.status).toBe(201);
    expect(db.checkout_intents).toHaveLength(1);
    const lookup = queries.find(
      (q) =>
        q.table === 'checkout_intents' &&
        q.op === 'select' &&
        q.filters.some(([c]) => c === 'provider_subscription_id')
    );
    // Even the recovery read is scoped by account.
    expect(lookup?.filters).toContainEqual(['account_id', ACCOUNT_A]);
  });

  it('fails closed when the intent cannot be recorded', async () => {
    insertFailure = { code: '42501' };

    const res = await post({ planId: 'pro', cycle: 'month' });
    expect(res.status).toBe(500);
    // No approval link: a payment we could not reconcile is worse than
    // a checkout the customer has to retry.
    expect(await res.json()).not.toHaveProperty('approvalUrl');
  });

  it('reports a PayPal refusal as a gateway error and writes nothing', async () => {
    createSubscription.mockRejectedValue(
      new PayPalError('nope', 422, { name: 'UNPROCESSABLE_ENTITY' })
    );

    const res = await post({ planId: 'pro', cycle: 'month' });
    expect(res.status).toBe(502);
    expect(db.checkout_intents).toHaveLength(0);
    expect(writesTo('subscriptions')).toEqual([]);
  });
});

describe('GET /api/billing/checkout (the return page status)', () => {
  beforeEach(() => {
    db.checkout_intents.push(
      {
        id: 'intent-a',
        account_id: ACCOUNT_A,
        plan_id: 'pro',
        cycle: 'month',
        provider: 'paypal',
        provider_plan_id: 'P-PRO-MONTH',
        provider_subscription_id: 'I-SUB-1',
        status: 'pending',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'intent-b',
        account_id: ACCOUNT_B,
        plan_id: 'negocio',
        cycle: 'year',
        provider: 'paypal',
        provider_plan_id: 'P-NEG-YEAR',
        provider_subscription_id: 'I-SUB-OTHER',
        status: 'activated',
        created_at: '2026-01-02T00:00:00.000Z',
      }
    );
  });

  it('reports "not activated yet" while the webhook has not arrived', async () => {
    const res = await get('?subscription_id=I-SUB-1');
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.activated).toBe(false);
    expect(json.intent).toMatchObject({
      planId: 'pro',
      cycle: 'month',
      status: 'pending',
      subscriptionId: 'I-SUB-1',
    });
    expect(json.subscription).toBeNull();
  });

  it('activates nothing by being called', async () => {
    // The acceptance criterion: the return URL is not an activator.
    // Calling it by hand, repeatedly, must leave the database alone.
    await get('?subscription_id=I-SUB-1');
    await get('?subscription_id=I-SUB-1');

    expect(queries.every((q) => q.op === 'select')).toBe(true);
    expect(db.subscriptions).toEqual([]);
    expect(db.checkout_intents[0].status).toBe('pending');
  });

  it('reports the activation the webhook performed', async () => {
    db.subscriptions.push({
      account_id: ACCOUNT_A,
      plan_id: 'pro',
      status: 'active',
      provider_subscription_id: 'I-SUB-1',
      current_period_end: '2026-02-01T00:00:00.000Z',
      cancel_at_period_end: false,
    });

    const json = await (await get('?subscription_id=I-SUB-1')).json();
    expect(json.activated).toBe(true);
    expect(json.subscription).toMatchObject({
      planId: 'pro',
      status: 'active',
    });
  });

  it('does not call another attempt activated', async () => {
    // An older subscription is active, but the customer just approved a
    // different one: the page must keep waiting instead of claiming it
    // is done.
    db.subscriptions.push({
      account_id: ACCOUNT_A,
      plan_id: 'inicio',
      status: 'active',
      provider_subscription_id: 'I-PREVIOUS',
      current_period_end: '2026-02-01T00:00:00.000Z',
      cancel_at_period_end: false,
    });

    const json = await (await get('?subscription_id=I-SUB-1')).json();
    expect(json.activated).toBe(false);
  });

  it('never shows another account its checkout', async () => {
    // `I-SUB-OTHER` exists — it belongs to account B.
    const json = await (await get('?subscription_id=I-SUB-OTHER')).json();

    expect(json.intent).toBeNull();
    const reads = queries.filter((q) => q.table === 'checkout_intents');
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.filters).toContainEqual(['account_id', ACCOUNT_A]);
    }
  });

  it('falls back to the account’s latest attempt with no id', async () => {
    const json = await (await get()).json();
    expect(json.intent).toMatchObject({ subscriptionId: 'I-SUB-1' });
  });

  it('refuses a caller below admin', async () => {
    db.profiles[0].account_role = 'viewer';
    expect((await get()).status).toBe(403);
  });
});

describe('the checkout route surface', () => {
  it('exposes only POST and GET', () => {
    // No PUT/PATCH/DELETE: there is no verb here that can move a
    // subscription forward, by design.
    expect(Object.keys(route).sort()).toEqual(['GET', 'POST']);
  });
});
