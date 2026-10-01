import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The statements on the operator's file (s10.4): GET the list,
// POST …/[sid]/confirm and …/[sid]/void. In-memory database with TWO
// managed companies, A and B, each with an open statement: whatever is
// done to A never touches B, and the bitácora goes first.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  failAudit: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => {
    const client = h.db.admin;
    if (!h.failAudit) return client;
    return {
      ...client,
      from: (table: string) => {
        if (table !== 'impersonation_log') return client.from(table);
        const failed = { data: null, error: { message: 'down' } };
        const chain = {
          insert: () => chain,
          select: () => chain,
          single: async () => failed,
        };
        return chain;
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
const confirmRoute = await import('./[sid]/confirm/route');
const voidRoute = await import('./[sid]/void/route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ST_A = 'aaaaaaaa-5555-4000-8000-000000000001';
const ST_B = 'bbbbbbbb-5555-4000-8000-000000000002';
const ST_A_NEXT = 'aaaaaaaa-5555-4000-8000-000000000003';

const PERIOD_START = '2026-10-01T00:00:00.000Z';
const PERIOD_END = '2026-11-01T00:00:00.000Z';
const DUE = '2026-11-04T00:00:00.000Z';
const NEXT_END = '2026-12-01T00:00:00.000Z';

function statement(
  id: string,
  accountId: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    account_id: accountId,
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    plan_fee_usd: 1036,
    usage_charge_usd: 33.9,
    total_usd: 1069.9,
    meta_cost_usd: 520.26,
    included_messages: 7000,
    messages_total: 8200,
    overage_messages: 1200,
    usage: {
      version: 1,
      lines: [
        {
          whatsapp_config_id: 'num-1',
          number: '+1 809 555 0001',
          category: 'service',
          market: 'rest_of_latam',
          meta_rate_usd: 0.0113,
          unit_price_usd: 0.02825,
          delivered: 1200,
          billable: 200,
          included: 0,
          overage: 1200,
          meta_cost_usd: 2.26,
          charge_usd: 33.9,
        },
      ],
      uncategorized: { total: 2, by_category: { marketing_lite: 2 } },
    },
    status: 'issued',
    issued_at: PERIOD_END,
    due_at: DUE,
    paid_at: null,
    paid_by: null,
    paid_reference: null,
    paid_note: null,
    claimed_paid_at: null,
    claim_note: null,
    ...over,
  };
}

function seed() {
  return {
    platform_admins: [
      { id: 'pa-1', user_id: OPERATOR, granted_at: null, note: 'test' },
    ],
    accounts: [
      { id: A, name: 'Company A', created_at: '2026-01-01T00:00:00.000Z' },
      { id: B, name: 'Company B', created_at: '2026-01-01T00:00:00.000Z' },
    ],
    subscriptions: [
      {
        id: 'sub-b',
        account_id: B,
        plan_id: 'gestionado',
        provider: 'manual',
        status: 'past_due',
        grace_until: DUE,
        current_period_end: PERIOD_END,
        statement_period_end: PERIOD_END,
        meta_billing: 'managed',
        payment_method: 'manual',
      },
      {
        id: 'sub-a',
        account_id: A,
        plan_id: 'gestionado',
        provider: 'manual',
        status: 'past_due',
        grace_until: DUE,
        current_period_end: PERIOD_END,
        statement_period_end: PERIOD_END,
        meta_billing: 'managed',
        payment_method: 'manual',
      },
    ],
    // B first: an unscoped lookup would land on it.
    statements: [statement(ST_B, B), statement(ST_A, A)],
    impersonation_log: [],
    // s10.7: the list also reads the reconciliation snapshots and the
    // account's connected WABAs.
    meta_spend_snapshots: [],
    whatsapp_config: [],
  };
}

const ctx = (id: string, sid = ST_A) => ({
  params: Promise.resolve({ id, sid }),
});

function post(
  route: { POST: typeof confirmRoute.POST },
  body: unknown,
  id = A,
  sid = ST_A
) {
  return route.POST(
    new Request(
      `http://localhost/api/platform/accounts/${id}/statements/${sid}/x`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    ),
    ctx(id, sid)
  );
}

function list(id = A) {
  return GET(
    new Request(`http://localhost/api/platform/accounts/${id}/statements`),
    { params: Promise.resolve({ id }) }
  );
}

const subOf = (acc: string) =>
  h.db.rows('subscriptions').find((r) => r.account_id === acc)!;
const stOf = (id: string) => h.db.rows('statements').find((r) => r.id === id)!;

let snapshotB = '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T15:00:00.000Z'));
  h.user = { id: OPERATOR };
  h.db = new FakeDatabase(seed());
  h.failAudit = false;
  snapshotB = JSON.stringify(h.db.snapshot(B));
});

afterEach(() => {
  vi.useRealTimers();
  // A↔B: nothing done to A ever touches B.
  expect(JSON.stringify(h.db.snapshot(B))).toBe(snapshotB);
});

describe('the guard', () => {
  it('401s without a session on all three, and nothing moves', async () => {
    h.user = null;
    const before = JSON.stringify(h.db.tables);
    expect((await list()).status).toBe(401);
    expect((await post(confirmRoute, {})).status).toBe(401);
    expect(
      (await post(voidRoute, { reason: 'duplicado del mes' })).status
    ).toBe(401);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it('403s a company owner on all three, and nothing moves', async () => {
    h.user = { id: PLAIN_OWNER };
    const before = JSON.stringify(h.db.tables);
    expect((await list()).status).toBe(403);
    expect((await post(confirmRoute, {})).status).toBe(403);
    expect(
      (await post(voidRoute, { reason: 'duplicado del mes' })).status
    ).toBe(403);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });
});

describe('GET — the list on the file', () => {
  it('lists the statements of A only, with the internal figures', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statements).toHaveLength(1);
    expect(body.statements[0]).toMatchObject({
      id: ST_A,
      totalUsd: 1069.9,
      metaCostUsd: 520.26,
      marginUsd: 549.64,
      status: 'issued',
      dueAt: DUE,
      uncategorized: { total: 2, byCategory: { marketing_lite: 2 } },
    });
    expect(body.statements[0].lines[0]).toMatchObject({
      billable: 200,
      meta_rate_usd: 0.0113,
    });
    expect(JSON.stringify(body)).not.toContain(ST_B);
  });

  it('404s a malformed id and a company that does not exist', async () => {
    expect((await list('nope')).status).toBe(404);
    expect((await list('dddddddd-0000-4000-8000-000000000004')).status).toBe(
      404
    );
  });
});

describe('POST …/confirm — «Confirmar pago»', () => {
  it('on time: paid, active, no grace, the cut-off one month after the period — trail first', async () => {
    const res = await post(confirmRoute, {
      paidAt: '2026-11-02',
      reference: 'TRX-123',
      note: 'transferencia Banreservas',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      currentPeriodEnd: NEXT_END,
      subscriptionStatus: 'active',
      statement: { id: ST_A, status: 'paid' },
    });

    expect(stOf(ST_A)).toMatchObject({
      status: 'paid',
      paid_at: '2026-11-02T12:00:00.000Z',
      paid_by: OPERATOR,
      paid_reference: 'TRX-123',
      paid_note: 'transferencia Banreservas',
    });
    // Manual: the anchor and the period move together.
    expect(subOf(A)).toMatchObject({
      status: 'active',
      grace_until: null,
      current_period_end: NEXT_END,
      statement_period_end: NEXT_END,
    });

    const [line] = h.db.rows('impersonation_log');
    expect(line).toMatchObject({
      action: 'payment_confirmed',
      account_id: A,
      actor_user_id: OPERATOR,
      details: {
        statement_id: ST_A,
        paid_reference: 'TRX-123',
        to_period_end: NEXT_END,
      },
    });
    expect((line.reason as string).length).toBeGreaterThanOrEqual(10);

    // The trail BEFORE the act.
    const writes = h.db.log
      .filter((e) => e.op !== 'select')
      .map((e) => e.table);
    expect(writes).toEqual([
      'impersonation_log',
      'subscriptions',
      'statements',
    ]);
  });

  it('late: paying on the 20th does not move the cut-off — the next period still ends a month after the previous one', async () => {
    vi.setSystemTime(new Date('2026-11-20T09:00:00.000Z'));
    const res = await post(confirmRoute, {});
    expect(res.status).toBe(200);
    // The next anchor starts from the previous one, not from the payment.
    expect(subOf(A).statement_period_end).toBe(NEXT_END);
    expect(subOf(A).current_period_end).toBe(NEXT_END);
    expect(stOf(ST_A).paid_at).toBe('2026-11-20T09:00:00.000Z');
  });

  it('PayPal: confirming moves the anchor and leaves current_period_end to PayPal', async () => {
    Object.assign(subOf(A), {
      provider: 'paypal',
      payment_method: 'paypal',
      // PayPal already renewed the fee and moved its own period.
      current_period_end: '2026-12-01T10:00:00.000Z',
    });
    await post(confirmRoute, {});
    expect(subOf(A)).toMatchObject({
      status: 'active',
      statement_period_end: NEXT_END,
      current_period_end: '2026-12-01T10:00:00.000Z',
    });
  });

  it('a retry after a half-done confirmation does not move the anchor twice', async () => {
    // The subscription step ran, the statement write did not.
    Object.assign(subOf(A), {
      status: 'active',
      grace_until: null,
      statement_period_end: NEXT_END,
      current_period_end: NEXT_END,
    });
    expect((await post(confirmRoute, {})).status).toBe(200);
    expect(subOf(A).statement_period_end).toBe(NEXT_END);
    expect(stOf(ST_A).status).toBe('paid');
  });

  it("404s B's statement addressed through A, and B is untouched", async () => {
    const res = await post(confirmRoute, {}, A, ST_B);
    expect(res.status).toBe(404);
    expect(h.db.rows('impersonation_log')).toEqual([]);
    expect(subOf(A)).toMatchObject({ status: 'past_due' });
  });

  it('409s a statement already paid, with no trail', async () => {
    stOf(ST_A).status = 'paid';
    stOf(ST_A).paid_at = '2026-11-01T10:00:00.000Z';
    const res = await post(confirmRoute, {});
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_open');
    expect(h.db.rows('impersonation_log')).toEqual([]);
  });

  it('500s and changes nothing when the trail cannot be written', async () => {
    h.failAudit = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = JSON.stringify(h.db.tables);
    const res = await post(confirmRoute, {});
    expect(res.status).toBe(500);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it.each([
    ['a payment date in the future', { paidAt: '2026-12-25' }],
    ['a date that is not one', { paidAt: 'ayer' }],
    ['a reference that is not text', { reference: 42 }],
    ['a reference too long', { reference: 'x'.repeat(201) }],
  ])('400s %s, and writes nothing', async (_label, body) => {
    const before = JSON.stringify(h.db.tables);
    expect((await post(confirmRoute, body)).status).toBe(400);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it('with another statement still open, the account keeps its grace until that one is due', async () => {
    h.db.rows('statements').push(
      statement(ST_A_NEXT, A, {
        period_start: PERIOD_END,
        period_end: NEXT_END,
        due_at: '2026-12-04T00:00:00.000Z',
      })
    );
    await post(confirmRoute, {});
    expect(subOf(A)).toMatchObject({
      status: 'past_due',
      grace_until: '2026-12-04T00:00:00.000Z',
    });
  });

  it('a PayPal failure that came first (an earlier grace) is not lifted by the statement', async () => {
    subOf(A).grace_until = '2026-11-03T00:00:00.000Z';
    subOf(A).payment_method = 'paypal';
    subOf(A).provider = 'paypal';
    await post(confirmRoute, {});
    expect(subOf(A)).toMatchObject({
      status: 'past_due',
      grace_until: '2026-11-03T00:00:00.000Z',
    });
    expect(stOf(ST_A).status).toBe('paid');
  });
});

describe('POST …/void — «Anular»', () => {
  it('400s a missing or short reason, and writes nothing', async () => {
    const before = JSON.stringify(h.db.tables);
    expect((await post(voidRoute, {})).status).toBe(400);
    expect((await post(voidRoute, { reason: 'corto' })).status).toBe(400);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it('void, the account back to active with the period extended the same way — trail with the reason first', async () => {
    const res = await post(voidRoute, {
      reason: 'emitido dos veces por error',
    });
    expect(res.status).toBe(200);
    expect(stOf(ST_A)).toMatchObject({ status: 'void', paid_at: null });
    expect(subOf(A)).toMatchObject({
      status: 'active',
      grace_until: null,
      current_period_end: NEXT_END,
      statement_period_end: NEXT_END,
    });
    expect(h.db.rows('impersonation_log')[0]).toMatchObject({
      action: 'statement_void',
      account_id: A,
      reason: 'emitido dos veces por error',
    });
    const writes = h.db.log
      .filter((e) => e.op !== 'select')
      .map((e) => e.table);
    expect(writes[0]).toBe('impersonation_log');
  });

  it("404s B's statement through A", async () => {
    expect(
      (
        await post(
          voidRoute,
          { reason: 'emitido dos veces por error' },
          A,
          ST_B
        )
      ).status
    ).toBe(404);
  });
});
