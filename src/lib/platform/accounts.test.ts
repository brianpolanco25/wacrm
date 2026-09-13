import { beforeEach, describe, expect, it, vi } from 'vitest';

// The data behind the platform panel. Two things are on trial here:
//
//   1. The panel shows what the database says. Consumption comes off
//      `usage_counters` untouched, the caps off the plan, and the
//      WhatsApp state off every row of `whatsapp_config` — f4.2 made
//      that a one-to-many relation and a single yes/no would lie about
//      at least one number.
//
//   2. CP3. Every query in this module runs with the service role, which
//      bypasses RLS, so the account filter is the ONLY thing keeping one
//      customer's file out of another's. The query log is asserted, not
//      just the answers.

interface Query {
  table: string;
  op: string;
  filters: [string, unknown][];
  patch?: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  /** Rows by table. */
  db: new Map<string, Record<string, unknown>[]>(),
  queries: [] as Query[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcRows: [] as Record<string, unknown>[],
  rpcError: null as unknown,
  error: null as unknown,
}));

function rows(table: string): Record<string, unknown>[] {
  if (!h.db.has(table)) h.db.set(table, []);
  return h.db.get(table)!;
}

function adminClient() {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      h.rpcCalls.push({ fn, args });
      return Promise.resolve(
        h.rpcError
          ? { data: null, error: h.rpcError }
          : { data: h.rpcRows, error: null }
      );
    },
    from(table: string) {
      const call: Query = { table, op: 'select', filters: [] };
      h.queries.push(call);

      const matches = (row: Record<string, unknown>) =>
        call.filters.every(([c, v]) => {
          if (c.startsWith('in:')) {
            return (v as unknown[]).includes(row[c.slice(3)]);
          }
          if (c.startsWith('like:')) {
            const prefix = String(v).replace(/%$/, '');
            return String(row[c.slice(5)] ?? '').startsWith(prefix);
          }
          if (c.startsWith('not-null:')) return row[c.slice(9)] != null;
          return v === null ? row[c] == null : row[c] === v;
        });

      const result = () =>
        h.error
          ? { data: null, error: h.error }
          : { data: rows(table).filter(matches), error: null };

      const builder = {
        select() {
          if (call.op === 'update') {
            const touched = rows(table).filter(matches);
            touched.forEach((r) => Object.assign(r, call.patch));
            return Promise.resolve(
              h.error
                ? { data: null, error: h.error }
                : { data: touched, error: null }
            );
          }
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        in(column: string, values: unknown[]) {
          call.filters.push([`in:${column}`, values]);
          return builder;
        },
        like(column: string, pattern: string) {
          call.filters.push([`like:${column}`, pattern]);
          return builder;
        },
        not(column: string, op: string, value: unknown) {
          call.filters.push([`not-null:${column}`, `${op}:${value}`]);
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return Promise.resolve(result());
        },
        update(patch: Record<string, unknown>) {
          call.op = 'update';
          call.patch = patch;
          return builder;
        },
        async maybeSingle() {
          if (h.error) return { data: null, error: h.error };
          return { data: rows(table).find(matches) ?? null, error: null };
        },
        then(
          resolve: (value: { data: unknown; error: unknown }) => unknown,
          reject?: (reason: unknown) => unknown
        ) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

vi.mock('@/lib/auth/admin-client', () => ({ supabaseAdmin: adminClient }));
// `getEntitlements` uses the automations admin client, not the auth one.
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: adminClient,
}));

const {
  listAccounts,
  loadAccountDetail,
  loadAccountSummary,
  setManualHold,
  MAX_PAGE_SIZE,
} = await import('./accounts');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const OPERATOR = '11111111-1111-4111-8111-111111111111';

/** Two companies, so every read has something wrong to return. */
function seed() {
  rows('accounts').push(
    { id: A, name: 'Company A', created_at: '2026-01-01T00:00:00.000Z' },
    { id: B, name: 'Company B', created_at: '2026-02-01T00:00:00.000Z' }
  );
  rows('plans').push({
    id: 'pro',
    name: 'Pro',
    limits: { messages_out: 15000, ai_replies: 3000, numbers: 1 },
    features: ['api'],
  });
  rows('subscriptions').push(
    {
      account_id: A,
      plan_id: 'pro',
      status: 'active',
      provider_subscription_id: 'I-AAA',
      current_period_end: '2026-10-01T00:00:00.000Z',
      grace_until: null,
      trial_ends_at: null,
      cancel_at_period_end: false,
      cycle: 'month',
      manual_hold_at: null,
      manual_hold_by: null,
      manual_hold_reason: null,
    },
    {
      account_id: B,
      plan_id: 'pro',
      status: 'active',
      provider_subscription_id: 'I-BBB',
      current_period_end: null,
      grace_until: null,
      trial_ends_at: null,
      cancel_at_period_end: false,
      cycle: 'month',
      manual_hold_at: null,
      manual_hold_by: null,
      manual_hold_reason: null,
    }
  );
  rows('profiles').push(
    {
      user_id: 'u-a1',
      account_id: A,
      full_name: 'Ana',
      email: 'ana@a.test',
      account_role: 'owner',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      user_id: 'u-b1',
      account_id: B,
      full_name: 'Bruno',
      email: 'bruno@b.test',
      account_role: 'owner',
      created_at: '2026-02-01T00:00:00.000Z',
    }
  );
  rows('whatsapp_config').push(
    {
      id: 'cfg-a1',
      account_id: A,
      phone_number_id: 'pn-a1',
      display_phone_number: '+1 555 0100',
      verified_name: 'Company A',
      label: 'Sales',
      waba_id: 'waba-a',
      status: 'connected',
      is_default: true,
      connected_at: '2026-03-01T00:00:00.000Z',
      registered_at: '2026-03-01T00:00:00.000Z',
      last_registration_error: null,
      access_token: 'SECRET-A',
      created_at: '2026-03-01T00:00:00.000Z',
    },
    {
      id: 'cfg-a2',
      account_id: A,
      phone_number_id: 'pn-a2',
      display_phone_number: '+1 555 0200',
      verified_name: 'Company A',
      label: 'Support',
      waba_id: 'waba-a',
      status: 'disconnected',
      is_default: false,
      connected_at: null,
      registered_at: null,
      last_registration_error: 'token expired',
      access_token: 'SECRET-A2',
      created_at: '2026-03-02T00:00:00.000Z',
    },
    {
      id: 'cfg-b1',
      account_id: B,
      phone_number_id: 'pn-b1',
      display_phone_number: '+1 555 0900',
      verified_name: 'Company B',
      label: null,
      waba_id: 'waba-b',
      status: 'connected',
      is_default: true,
      connected_at: null,
      registered_at: null,
      last_registration_error: null,
      access_token: 'SECRET-B',
      created_at: '2026-03-01T00:00:00.000Z',
    }
  );
  rows('conversations').push(
    { account_id: A, last_message_at: '2026-09-10T12:00:00.000Z' },
    { account_id: B, last_message_at: '2026-09-11T12:00:00.000Z' }
  );
  rows('checkout_intents').push(
    {
      account_id: A,
      provider: 'paypal',
      provider_subscription_id: 'I-AAA-OLD',
    },
    { account_id: B, provider: 'paypal', provider_subscription_id: 'I-BBB' }
  );
  rows('impersonation_log').push(
    {
      id: 'log-a',
      account_id: A,
      action: 'suspend',
      actor_user_id: OPERATOR,
      reason: 'chargebacks, ticket 88',
      started_at: '2026-09-01T00:00:00.000Z',
      ended_at: null,
      ended_reason: null,
    },
    {
      id: 'log-b',
      account_id: B,
      action: 'impersonation',
      actor_user_id: OPERATOR,
      reason: 'ticket 99: the inbox is empty',
      started_at: '2026-09-02T00:00:00.000Z',
      ended_at: null,
      ended_reason: null,
    }
  );
  rows('billing_events').push(
    {
      id: 'ev-sale-a',
      provider: 'paypal',
      event_type: 'PAYMENT.SALE.COMPLETED',
      received_at: '2026-08-01T00:00:00.000Z',
      processed_at: '2026-08-01T00:00:01.000Z',
      error: null,
      payload: {
        resource: {
          id: 'SALE-A',
          billing_agreement_id: 'I-AAA',
          amount: { total: '79.00', currency: 'USD' },
        },
      },
      'payload->resource->>billing_agreement_id': 'I-AAA',
      'payload->resource->>id': 'SALE-A',
    },
    {
      id: 'ev-sale-b',
      provider: 'paypal',
      event_type: 'PAYMENT.SALE.COMPLETED',
      received_at: '2026-08-02T00:00:00.000Z',
      processed_at: null,
      error: null,
      payload: {
        resource: {
          id: 'SALE-B',
          billing_agreement_id: 'I-BBB',
          amount: { total: '199.00', currency: 'USD' },
        },
      },
      'payload->resource->>billing_agreement_id': 'I-BBB',
      'payload->resource->>id': 'SALE-B',
    },
    {
      id: 'ev-susp-a',
      provider: 'paypal',
      event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
      received_at: '2026-08-15T00:00:00.000Z',
      processed_at: '2026-08-15T00:00:01.000Z',
      error: null,
      payload: { resource: { id: 'I-AAA' } },
      'payload->resource->>billing_agreement_id': null,
      'payload->resource->>id': 'I-AAA',
    }
  );
}

/** Every query that named an account, and which one. */
function scopedAccountIds(): unknown[] {
  return h.queries
    .flatMap((q) => q.filters)
    .filter(([c]) => c === 'account_id' || c === 'id')
    .map(([, v]) => v);
}

beforeEach(() => {
  h.db = new Map();
  h.queries = [];
  h.rpcCalls = [];
  h.rpcRows = [];
  h.rpcError = null;
  h.error = null;
  seed();
});

describe('listAccounts — the census (spec §2, «Listado de cuentas»)', () => {
  it('returns one row per account with plan, members, usage and last activity', async () => {
    h.rpcRows = [
      {
        account_id: B,
        name: 'Company B',
        created_at: '2026-02-01T00:00:00.000Z',
        member_count: 4,
        plan_id: 'pro',
        subscription_status: 'active',
        manual_hold_at: null,
        trial_ends_at: null,
        current_period_end: null,
        grace_until: null,
        last_activity_at: '2026-09-11T12:00:00.000Z',
        usage: { messages_out: 120, ai_replies: 7 },
        total_count: 2,
      },
      {
        account_id: A,
        name: 'Company A',
        created_at: '2026-01-01T00:00:00.000Z',
        member_count: 1,
        plan_id: 'pro',
        subscription_status: 'active',
        manual_hold_at: '2026-09-01T00:00:00.000Z',
        trial_ends_at: null,
        current_period_end: null,
        grace_until: null,
        last_activity_at: null,
        usage: {},
        total_count: 2,
      },
    ];

    const page = await listAccounts({});

    expect(page.total).toBe(2);
    expect(page.accounts).toHaveLength(2);
    expect(page.accounts[0]).toMatchObject({
      accountId: B,
      name: 'Company B',
      memberCount: 4,
      planId: 'pro',
      subscriptionStatus: 'active',
      lastActivityAt: '2026-09-11T12:00:00.000Z',
    });
    // Consumption verbatim, not scaled or capped.
    expect(page.accounts[0].usage).toEqual({
      messages_out: 120,
      ai_replies: 7,
    });
    // And the hold is visible in the list, which is where an operator
    // looks to answer "who have we cut off?".
    expect(page.accounts[1].manualHoldAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('goes through the function of migration 058, never a table scan', async () => {
    await listAccounts({ search: '  Company A  ', limit: 10, offset: 20 });
    expect(h.rpcCalls).toEqual([
      {
        fn: 'platform_account_list',
        args: { p_search: 'Company A', p_limit: 10, p_offset: 20 },
      },
    ]);
    // Nothing else was read: no per-row round trips.
    expect(h.queries).toEqual([]);
  });

  it('clamps the page size and refuses a negative offset', async () => {
    await listAccounts({ limit: 100_000, offset: -5 });
    expect(h.rpcCalls[0].args.p_limit).toBe(MAX_PAGE_SIZE);
    expect(h.rpcCalls[0].args.p_offset).toBe(0);

    await listAccounts({ limit: 0, offset: 0 });
    expect(h.rpcCalls[1].args.p_limit).toBe(1);
  });

  it('turns an empty search into no filter at all', async () => {
    await listAccounts({ search: '   ' });
    expect(h.rpcCalls[0].args.p_search).toBeNull();
  });

  it('reports zero — not a crash — for a page past the end', async () => {
    h.rpcRows = [];
    const page = await listAccounts({ offset: 9999 });
    expect(page).toMatchObject({ accounts: [], total: 0 });
  });

  it('throws rather than degrading into an empty census', async () => {
    h.rpcError = { message: 'connection reset' };
    await expect(listAccounts({})).rejects.toBeTruthy();
  });
});

describe('loadAccountDetail — the file (spec §2, «Ficha de cuenta»)', () => {
  it('shows consumption per metric against the plan caps', async () => {
    rows('usage_counters').push(
      {
        account_id: A,
        metric: 'messages_out',
        value: 4200,
        period_start: new Date().toISOString().slice(0, 7) + '-01',
      },
      {
        account_id: B,
        metric: 'messages_out',
        value: 99999,
        period_start: new Date().toISOString().slice(0, 7) + '-01',
      }
    );

    const detail = (await loadAccountDetail(A))!;
    const messages = detail.usage.find((u) => u.metric === 'messages_out')!;
    // A's number, not B's, and not a rounded or capped version of it.
    expect(messages.used).toBe(4200);
    expect(messages.limit).toBe(15000);
    // The stock caps have no counter and must not be invented as zeros.
    expect(detail.usage.some((u) => u.metric === 'numbers')).toBe(false);
    expect(detail.limits.numbers).toBe(1);
  });

  it('lists every WhatsApp number, not one (f4.2)', async () => {
    const detail = (await loadAccountDetail(A))!;
    expect(detail.numbers.map((n) => n.phoneNumberId)).toEqual([
      'pn-a1',
      'pn-a2',
    ]);
    expect(detail.numbers[0]).toMatchObject({
      isDefault: true,
      status: 'connected',
    });
    expect(detail.numbers[1]).toMatchObject({
      isDefault: false,
      status: 'disconnected',
      lastRegistrationError: 'token expired',
    });
  });

  it('never hands the operator a customer access token', async () => {
    const detail = (await loadAccountDetail(A))!;
    expect(JSON.stringify(detail)).not.toContain('SECRET-A');
    const numbersQuery = h.queries.find((q) => q.table === 'whatsapp_config')!;
    expect(numbersQuery).toBeTruthy();
  });

  it('shows the billing history: payments AND status events', async () => {
    const detail = (await loadAccountDetail(A))!;
    const types = detail.billingHistory.map((e) => e.eventType);
    expect(types).toContain('PAYMENT.SALE.COMPLETED');
    expect(types).toContain('BILLING.SUBSCRIPTION.SUSPENDED');
    // B's payment is not in A's file.
    expect(detail.billingHistory.map((e) => e.id)).not.toContain('ev-sale-b');
    const sale = detail.billingHistory.find((e) => e.id === 'ev-sale-a')!;
    // PayPal's own decimal string, never re-rounded.
    expect(sale.amount).toBe('79.00');
    expect(sale.currency).toBe('USD');
  });

  it('does not echo the gateway payloads into the panel', async () => {
    const detail = (await loadAccountDetail(A))!;
    expect(
      detail.billingHistory.every(
        (e) => !Object.prototype.hasOwnProperty.call(e, 'payload')
      )
    ).toBe(true);
  });

  it('carries the platform audit trail of THIS account only', async () => {
    const detail = (await loadAccountDetail(A))!;
    expect(detail.audit.map((e) => e.id)).toEqual(['log-a']);
    expect(detail.audit[0]).toMatchObject({
      action: 'suspend',
      actorUserId: OPERATOR,
      reason: 'chargebacks, ticket 88',
    });
  });

  it('reports the members and the signup date', async () => {
    const detail = (await loadAccountDetail(A))!;
    expect(detail.members.map((m) => m.email)).toEqual(['ana@a.test']);
    expect(detail.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is a null — not another account — for an id that does not exist', async () => {
    expect(
      await loadAccountDetail('dddddddd-0000-4000-8000-00000000dead')
    ).toBeNull();
  });

  it('scopes EVERY service-role query by the account it is about (CP3)', async () => {
    await loadAccountDetail(A);

    const tenantTables = [
      'accounts',
      'subscriptions',
      'profiles',
      'whatsapp_config',
      'usage_counters',
      'conversations',
      'checkout_intents',
      'impersonation_log',
    ];
    for (const table of tenantTables) {
      const queries = h.queries.filter((q) => q.table === table);
      expect(queries.length).toBeGreaterThan(0);
      for (const q of queries) {
        const scoped = q.filters.some(
          ([c, v]) => (c === 'account_id' || c === 'id') && v === A
        );
        expect(scoped, `${table} was queried without the account filter`).toBe(
          true
        );
      }
    }
    // And nothing was ever asked about the other company.
    expect(scopedAccountIds()).not.toContain(B);
  });

  it('reaches billing_events only through THIS account subscription ids', async () => {
    await loadAccountDetail(A);
    const eventQueries = h.queries.filter((q) => q.table === 'billing_events');
    expect(eventQueries.length).toBe(2);
    for (const q of eventQueries) {
      const ids = q.filters.find(([c]) => c.startsWith('in:'))?.[1] as string[];
      // `billing_events` has no account_id — the tenant filter is the id
      // list, and it must not contain another account's subscription.
      expect(ids).toEqual(expect.arrayContaining(['I-AAA', 'I-AAA-OLD']));
      expect(ids).not.toContain('I-BBB');
    }
  });

  it('does not query the gateway log at all when the account never paid', async () => {
    rows('subscriptions').find(
      (r) => r.account_id === A
    )!.provider_subscription_id = null;
    h.db.set(
      'checkout_intents',
      rows('checkout_intents').filter((r) => r.account_id !== A)
    );

    const detail = (await loadAccountDetail(A))!;
    expect(detail.billingHistory).toEqual([]);
    expect(h.queries.some((q) => q.table === 'billing_events')).toBe(false);
  });
});

describe('setManualHold — suspend and reactivate by hand (spec §2)', () => {
  it('writes only the hold columns and NEVER the subscription status', async () => {
    const before = {
      ...rows('subscriptions').find((r) => r.account_id === A)!,
    };

    expect(
      await setManualHold({
        accountId: A,
        hold: true,
        actorUserId: OPERATOR,
        reason: 'chargebacks, ticket 88',
      })
    ).toBe(true);

    const patch = h.queries.find((q) => q.op === 'update')!.patch!;
    // The whole design in one assertion: `status` belongs to the PayPal
    // webhook. A hold written there would be lifted by the next event.
    expect(Object.keys(patch).sort()).toEqual([
      'manual_hold_at',
      'manual_hold_by',
      'manual_hold_reason',
    ]);

    const after = rows('subscriptions').find((r) => r.account_id === A)!;
    expect(after.status).toBe(before.status);
    expect(after.plan_id).toBe(before.plan_id);
    expect(after.manual_hold_by).toBe(OPERATOR);
    expect(after.manual_hold_reason).toBe('chargebacks, ticket 88');
    expect(after.manual_hold_at).toBeTruthy();
  });

  it('scopes the write to the account it names, and touches no other (CP3)', async () => {
    await setManualHold({
      accountId: A,
      hold: true,
      actorUserId: OPERATOR,
      reason: 'chargebacks, ticket 88',
    });

    const update = h.queries.find((q) => q.op === 'update')!;
    expect(update.filters).toEqual([['account_id', A]]);
    expect(
      rows('subscriptions').find((r) => r.account_id === B)!.manual_hold_at
    ).toBeNull();
  });

  it('lifting clears all three columns, so nothing lingers', async () => {
    await setManualHold({
      accountId: A,
      hold: true,
      actorUserId: OPERATOR,
      reason: 'chargebacks, ticket 88',
    });
    await setManualHold({
      accountId: A,
      hold: false,
      actorUserId: OPERATOR,
      reason: 'refunded, ticket 88 closed',
    });

    const after = rows('subscriptions').find((r) => r.account_id === A)!;
    expect(after.manual_hold_at).toBeNull();
    expect(after.manual_hold_by).toBeNull();
    expect(after.manual_hold_reason).toBeNull();
  });

  it('reports false when there is no subscription row to hold', async () => {
    h.db.set('subscriptions', []);
    expect(
      await setManualHold({
        accountId: A,
        hold: true,
        actorUserId: OPERATOR,
        reason: 'chargebacks, ticket 88',
      })
    ).toBe(false);
  });
});

describe('loadAccountSummary', () => {
  it('resolves the account by its primary key, which is its scope', async () => {
    expect(await loadAccountSummary(A)).toEqual({
      id: A,
      name: 'Company A',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(h.queries[0].filters).toEqual([['id', A]]);
  });

  it('is null for an account that does not exist', async () => {
    expect(
      await loadAccountSummary('dddddddd-0000-4000-8000-00000000dead')
    ).toBeNull();
  });
});
