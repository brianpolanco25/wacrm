import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/billing/cron (s10.4) against the in-memory database, which
// evaluates the queries for real: the cut-off of managed accounts, its
// idempotency, PayPal without overage, the account skipped for a
// missing rate, and that nothing else moves.

const h = vi.hoisted(() => ({
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/flows/admin-client', async () => {
  const mod = await import('@/lib/security/fake-supabase');
  const forward = mod.forwardingClient(() => h.db.admin);
  return { supabaseAdmin: () => forward };
});

// ~14.000 seeded deliveries evaluated by the in-memory database: each
// sweep takes well under a second on an idle machine, but several on a
// loaded one. A roomier limit than the 5 s default keeps it from flaking.
vi.setConfig({ testTimeout: 30_000 });

const { FakeDatabase, FakeClient } =
  await import('@/lib/security/fake-supabase');
const { GET } = await import('./route');

const SECRET = 'billing-cron-secret';
const A = 'acct-a'; // managed, manual
const B = 'acct-b'; // managed, PayPal, no overage
const C = 'acct-c'; // managed, PayPal, with overage
const D = 'acct-d'; // managed, manual, its numbers go to Mexico (no rate)
const E = 'acct-e'; // direct
const F = 'acct-f'; // managed, period not over yet
const G = 'acct-g'; // managed, PayPal not activated yet (incomplete)

const PERIOD_END = '2026-11-01T00:00:00.000Z';
const PERIOD_START = '2026-10-01T00:00:00.000Z';
const NOW = '2026-11-01T06:00:00.000Z';
const RD = '18095550000';
const MX = '5215550000000';

const PRICING = {
  included_messages: 7000,
  fee_usd: 1036,
  overage: {
    service: { multiplier: 2.5 },
    utility: { multiplier: 2.5 },
    marketing: { multiplier: 2.5 },
    authentication: { multiplier: 2.5 },
    authentication_international: { multiplier: 2.5 },
  },
};

function sub(
  accountId: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: `sub-${accountId}`,
    account_id: accountId,
    plan_id: 'gestionado',
    provider: 'manual',
    status: 'active',
    payment_method: 'manual',
    meta_billing: 'managed',
    meta_pricing: PRICING,
    current_period_end: PERIOD_END,
    statement_period_end: PERIOD_END,
    grace_until: null,
    ...over,
  };
}

let seq = 0;
function charges(
  accountId: string,
  count: number,
  opts: { category?: string; phone?: string; fromMs?: number } = {}
) {
  const from = opts.fromMs ?? Date.parse('2026-10-05T00:00:00.000Z');
  return Array.from({ length: count }, (_, i) => {
    seq += 1;
    return {
      id: `mc-${String(seq).padStart(6, '0')}`,
      account_id: accountId,
      wamid: `wamid.${seq}`,
      whatsapp_config_id: `num-${accountId}`,
      recipient_phone: opts.phone ?? RD,
      pricing_category: opts.category ?? 'marketing',
      pricing_billable: true,
      status: 'delivered',
      delivered_at: new Date(from + i * 1000).toISOString(),
    };
  });
}

function seed() {
  return {
    subscriptions: [
      sub(A),
      sub(B, { provider: 'paypal', payment_method: 'paypal' }),
      sub(C, { provider: 'paypal', payment_method: 'paypal' }),
      sub(D),
      sub(E, {
        plan_id: 'pro',
        provider: 'paypal',
        payment_method: null,
        meta_billing: 'direct',
        meta_pricing: {},
        statement_period_end: null,
      }),
      sub(F, {
        current_period_end: '2026-11-20T00:00:00.000Z',
        statement_period_end: '2026-11-20T00:00:00.000Z',
      }),
      sub(G, {
        provider: 'paypal',
        payment_method: 'paypal',
        status: 'incomplete',
      }),
    ],
    message_charges: [
      ...charges(A, 7010), // 10 overage
      ...charges(B, 3000),
      ...charges(C, 7100), // 100 overage
      ...charges(D, 5, { phone: MX }),
      ...charges(E, 50),
      ...charges(F, 50),
    ],
    whatsapp_config: [A, B, C, D, E, F].map((acc) => ({
      id: `num-${acc}`,
      account_id: acc,
      display_phone_number: `+1 809 000 ${acc}`,
      label: null,
    })),
    meta_rates: [
      {
        market: 'rest_of_latam',
        category: 'marketing',
        usd_per_message: '0.07400',
        effective_from: '2026-10-01',
      },
      {
        market: 'rest_of_latam',
        category: 'service',
        usd_per_message: '0.01130',
        effective_from: '2026-10-01',
      },
    ],
    meta_market_countries: [
      { country_code: 'DO', market: 'rest_of_latam' },
      { country_code: 'MX', market: 'mexico' },
    ],
    statements: [],
    messages: [],
    conversations: [],
  };
}

function req(secret?: string) {
  return new Request('https://crm.example.com/api/billing/cron', {
    headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  });
}

function subOf(accountId: string) {
  return h.db.rows('subscriptions').find((r) => r.account_id === accountId)!;
}

function statementsOf(accountId: string) {
  return h.db.rows('statements').filter((r) => r.account_id === accountId);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  process.env.BILLING_CRON_SECRET = SECRET;
  h.db = new FakeDatabase(seed());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // s10.7: no test reaches Graph. A test that wants answers stubs its own.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no network in tests');
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.BILLING_CRON_SECRET;
});

describe('the secret', () => {
  it('503s while BILLING_CRON_SECRET is unset, and does nothing', async () => {
    delete process.env.BILLING_CRON_SECRET;
    const res = await GET(req(SECRET));
    expect(res.status).toBe(503);
    expect(h.db.log).toEqual([]);
  });

  it('401s a missing or wrong secret, and does nothing', async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req('wrong'))).status).toBe(401);
    expect((await GET(req(`${SECRET}x`))).status).toBe(401);
    expect(h.db.log).toEqual([]);
  });
});

describe('the cut-off', () => {
  it('issues the statement of a manual account: issued, due in three days, past_due until then, period end untouched', async () => {
    const res = await GET(req(SECRET));
    expect(res.status).toBe(200);

    const [st] = statementsOf(A);
    expect(st).toMatchObject({
      account_id: A,
      period_start: PERIOD_START,
      period_end: PERIOD_END,
      status: 'issued',
      due_at: '2026-11-04T00:00:00.000Z',
      plan_fee_usd: 1036,
      messages_total: 7010,
      overage_messages: 10,
      usage_charge_usd: 1.85, // 10 × 0,0740 × 2,5
      total_usd: 1037.85,
    });
    expect(subOf(A)).toMatchObject({
      status: 'past_due',
      grace_until: '2026-11-04T00:00:00.000Z',
      current_period_end: PERIOD_END,
      statement_period_end: PERIOD_END,
    });
  });

  it('is idempotent: three runs the same day issue ONE statement per account', async () => {
    const bodies = [];
    for (let i = 0; i < 3; i++) {
      const res = await GET(req(SECRET));
      expect(res.status).toBe(200);
      bodies.push((await res.json()).statements);
    }
    expect(statementsOf(A)).toHaveLength(1);
    expect(statementsOf(C)).toHaveLength(1);
    expect(h.db.rows('statements')).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ issued: 2, extended: 1, failed: 1 });
    expect(bodies[1]).toMatchObject({ issued: 0, existing: 2, failed: 1 });
    expect(bodies[2]).toMatchObject({ issued: 0, existing: 2, failed: 1 });
    // The anchor of B was moved once, not three times.
    expect(subOf(B).statement_period_end).toBe('2026-12-01T00:00:00.000Z');
  });

  it('PayPal with no overage: no statement, no cut-off, the anchor moves a month and the period stays PayPal’s', async () => {
    await GET(req(SECRET));
    expect(statementsOf(B)).toEqual([]);
    expect(subOf(B)).toMatchObject({
      status: 'active',
      grace_until: null,
      statement_period_end: '2026-12-01T00:00:00.000Z',
      current_period_end: PERIOD_END,
    });
  });

  it('manual with nothing to bill (fee 0, no overage): the anchor and the period move together', async () => {
    Object.assign(subOf(A), {
      meta_pricing: { ...PRICING, fee_usd: 0, included_messages: 100000 },
    });
    await GET(req(SECRET));
    expect(statementsOf(A)).toEqual([]);
    expect(subOf(A)).toMatchObject({
      statement_period_end: '2026-12-01T00:00:00.000Z',
      current_period_end: '2026-12-01T00:00:00.000Z',
    });
  });

  it('a PayPal renewal processed BEFORE the sweep (period end already in the future) still gets its overage billed', async () => {
    // PAYMENT.SALE.COMPLETED moved current_period_end to next month; the
    // anchor stayed at the cut-off.
    subOf(C).current_period_end = '2026-12-01T00:00:00.000Z';
    await GET(req(SECRET));
    const [st] = statementsOf(C);
    expect(st).toMatchObject({
      period_start: PERIOD_START,
      period_end: PERIOD_END,
      total_usd: 18.5,
      status: 'issued',
    });
    expect(subOf(C)).toMatchObject({
      status: 'past_due',
      statement_period_end: PERIOD_END,
      current_period_end: '2026-12-01T00:00:00.000Z',
    });
  });

  it('a managed account with no anchor is not swept', async () => {
    subOf(A).statement_period_end = null;
    await GET(req(SECRET));
    expect(statementsOf(A)).toEqual([]);
  });

  it('PayPal with overage: a statement of the overage alone, and it cuts off like the manual one', async () => {
    await GET(req(SECRET));
    const [st] = statementsOf(C);
    expect(st).toMatchObject({
      plan_fee_usd: 0,
      overage_messages: 100,
      usage_charge_usd: 18.5, // 100 × 0,0740 × 2,5
      total_usd: 18.5,
      status: 'issued',
    });
    expect(subOf(C)).toMatchObject({
      status: 'past_due',
      grace_until: '2026-11-04T00:00:00.000Z',
    });
  });

  it('a missing Meta rate skips THAT account with its error; the others are billed', async () => {
    const res = await GET(req(SECRET));
    const body = (await res.json()).statements;
    expect(body.failed).toBe(1);
    expect(body.errors).toEqual([
      expect.objectContaining({
        accountId: D,
        kind: 'rate_missing',
        periodEnd: PERIOD_END,
      }),
    ]);
    expect(body.errors[0].error).toContain('mexico');
    expect(statementsOf(D)).toEqual([]);
    expect(subOf(D)).toMatchObject({ status: 'active', grace_until: null });
    expect(statementsOf(A)).toHaveLength(1);
  });

  it('leaves alone a direct account, a period not over yet and an account PayPal has not activated', async () => {
    const before = {
      E: { ...subOf(E) },
      F: { ...subOf(F) },
      G: { ...subOf(G) },
    };
    await GET(req(SECRET));
    expect(subOf(E)).toEqual(before.E);
    expect(subOf(F)).toEqual(before.F);
    expect(subOf(G)).toEqual(before.G);
    expect(statementsOf(E)).toEqual([]);
    expect(statementsOf(F)).toEqual([]);
    expect(statementsOf(G)).toEqual([]);
  });

  it('every write is scoped to the account being billed (A↔B)', async () => {
    await GET(req(SECRET));
    const writes = h.db.log.filter((e) => e.op !== 'select');
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      if (w.op === 'update') {
        expect(w.filters.some((f) => f.column === 'account_id')).toBe(true);
      } else {
        for (const row of w.payload ?? []) {
          expect(typeof row.account_id).toBe('string');
        }
      }
    }
    // Every read of charges is filtered by account as well.
    for (const e of h.db.log.filter((x) => x.table === 'message_charges')) {
      expect(e.filters.some((f) => f.column === 'account_id')).toBe(true);
    }
    // The statement of A has only A's deliveries.
    expect(statementsOf(A)[0].messages_total).toBe(7010);
  });

  it('CP11: the sweep never writes anything to the inbound tables', async () => {
    await GET(req(SECRET));
    const touched = h.db.log
      .filter((e) => e.op !== 'select')
      .map((e) => e.table);
    expect(new Set(touched)).toEqual(new Set(['statements', 'subscriptions']));
  });

  it('heals a run that died between the two writes: the lock is re-applied, nothing re-issued', async () => {
    h.db.rows('statements').push({
      id: 'st-a',
      account_id: A,
      period_start: PERIOD_START,
      period_end: PERIOD_END,
      status: 'issued',
      due_at: '2026-11-04T00:00:00.000Z',
      total_usd: 1036,
    });
    await GET(req(SECRET));
    expect(statementsOf(A)).toHaveLength(1);
    expect(subOf(A)).toMatchObject({
      status: 'past_due',
      grace_until: '2026-11-04T00:00:00.000Z',
    });
  });

  it('a payment confirmed between the listing and the lock leaves the account active', async () => {
    h.db.rows('statements').push({
      id: 'st-a',
      account_id: A,
      period_start: PERIOD_START,
      period_end: PERIOD_END,
      status: 'issued',
      due_at: '2026-11-04T00:00:00.000Z',
      total_usd: 1036,
    });
    // The operator confirms while the sweep runs: settleStatement writes
    // the subscription first (active, anchor a month on) and the
    // statement after, so the sweep still reads it `issued`.
    const original = FakeClient.prototype.from;
    let settled = false;
    vi.spyOn(FakeClient.prototype, 'from').mockImplementation(function (
      this: InstanceType<typeof FakeClient>,
      table: string
    ) {
      if (table === 'statements' && !settled) {
        settled = true;
        Object.assign(subOf(A), {
          status: 'active',
          grace_until: null,
          statement_period_end: '2026-12-01T00:00:00.000Z',
          current_period_end: '2026-12-01T00:00:00.000Z',
        });
      }
      return original.call(this, table);
    });
    await GET(req(SECRET));
    expect(settled).toBe(true);
    expect(subOf(A)).toMatchObject({
      status: 'active',
      grace_until: null,
      statement_period_end: '2026-12-01T00:00:00.000Z',
    });
  });

  it('a settled statement for that cut-off is never re-issued nor re-locks the account', async () => {
    h.db.rows('statements').push({
      id: 'st-a',
      account_id: A,
      period_start: PERIOD_START,
      period_end: PERIOD_END,
      status: 'paid',
      due_at: '2026-11-04T00:00:00.000Z',
      paid_at: NOW,
      total_usd: 1036,
    });
    await GET(req(SECRET));
    expect(statementsOf(A)).toHaveLength(1);
    expect(subOf(A)).toMatchObject({ status: 'active', grace_until: null });
  });

  it('starts the period where the previous statement ended', async () => {
    h.db.rows('statements').push({
      id: 'st-prev',
      account_id: A,
      period_start: '2026-09-01T00:00:00.000Z',
      period_end: '2026-10-03T00:00:00.000Z',
      status: 'paid',
      due_at: '2026-10-06T00:00:00.000Z',
      paid_at: '2026-10-04T00:00:00.000Z',
      total_usd: 1036,
    });
    await GET(req(SECRET));
    const issued = statementsOf(A).find((s) => s.period_end === PERIOD_END)!;
    expect(issued.period_start).toBe('2026-10-03T00:00:00.000Z');
  });
});

describe('the reconciliation with Meta (s10.7)', () => {
  it('the response carries the `reconciliation` block; managed WABAs are fetched (Graph mocked), the direct one is not', async () => {
    const { encrypt } = await import('@/lib/whatsapp/encryption');
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    for (const cfg of h.db.rows('whatsapp_config')) {
      cfg.status = 'connected';
      cfg.waba_id = `W-${cfg.account_id}`;
      cfg.access_token = encrypt(`token-${cfg.account_id}`);
    }
    const fetchMock = vi.fn(async (url: string) => {
      const waba = new URL(url).pathname.split('/').pop();
      return new Response(
        JSON.stringify({
          id: waba,
          pricing_analytics: {
            data: [
              {
                data_points: [
                  {
                    start: Date.parse('2026-10-05T00:00:00.000Z') / 1000,
                    end: Date.parse('2026-10-06T00:00:00.000Z') / 1000,
                    phone_number: '18090000000',
                    pricing_category: 'MARKETING',
                    volume: 10,
                    cost: 0.74,
                  },
                ],
              },
            ],
          },
        })
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await GET(req(SECRET));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.statements).toMatchObject({ issued: 2 });
      // A, B, C, D, F are managed with a connected number (G has none); E
      // is direct and is never asked.
      expect(body.reconciliation).toEqual({
        scanned: 5,
        fetched: 5,
        skipped: 0,
        failed: 0,
      });
      const asked = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(asked.some((u) => u.includes(`/W-${E}?`))).toBe(false);
      const snaps = h.db.rows('meta_spend_snapshots');
      expect(snaps.filter((s) => s.account_id === A)).toEqual([
        expect.objectContaining({ waba_id: `W-${A}`, cost_usd: 0.74 }),
      ]);

      // Same day again: nothing asked, everything skipped.
      fetchMock.mockClear();
      const again = await (await GET(req(SECRET))).json();
      expect(again.reconciliation).toMatchObject({ fetched: 0, skipped: 5 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
