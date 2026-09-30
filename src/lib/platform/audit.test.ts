import { beforeEach, describe, expect, it, vi } from 'vitest';

// The platform's audit trail. The spec's wording about impersonation
// applies word for word to suspending an account: without a record of
// who did it, when, to whom and why, it is a back door. Migration 058
// put both in `impersonation_log`, told apart by `action`.

interface Query {
  table: string;
  op: string;
  filters: [string, unknown][];
  payload?: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  queries: [] as Query[],
  insertError: null as unknown,
  selectError: null as unknown,
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call: Query = { table, op: 'select', filters: [] };
      h.queries.push(call);
      const matches = (row: Record<string, unknown>) =>
        call.filters.every(([c, v]) => row[c] === v);
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        limit() {
          return Promise.resolve(
            h.selectError
              ? { data: null, error: h.selectError }
              : { data: h.rows.filter(matches), error: null }
          );
        },
        is(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        update(payload: Record<string, unknown>) {
          call.op = 'update';
          call.payload = payload;
          return builder;
        },
        then(resolve: (v: unknown) => void) {
          // An awaited update: apply it to the matching rows.
          for (const row of h.rows.filter(matches)) {
            Object.assign(row, call.payload);
          }
          resolve({ data: null, error: null });
        },
        insert(payload: Record<string, unknown>) {
          call.op = 'insert';
          call.payload = payload;
          const result = h.insertError
            ? { data: null, error: h.insertError }
            : (h.rows.push({ id: 'log-new', ...payload }),
              { data: { id: 'log-new' }, error: null });
          return { select: () => ({ single: async () => result }) };
        },
      };
      return builder;
    },
  }),
}));

const {
  attachAccountToAuditRow,
  recordPlatformAction,
  loadAccountAudit,
  MIN_REASON_LENGTH,
} = await import('./audit');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const OPERATOR = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  h.rows = [];
  h.queries = [];
  h.insertError = null;
  h.selectError = null;
});

describe('recordPlatformAction', () => {
  it('records actor, account, moment and reason — the four the spec names', async () => {
    expect(
      await recordPlatformAction({
        action: 'suspend',
        actorUserId: OPERATOR,
        accountId: A,
        accountName: 'Company A',
        reason: 'chargebacks, ticket 88',
      })
    ).toBe('log-new');

    const [call] = h.queries;
    expect(call.table).toBe('impersonation_log');
    expect(call.op).toBe('insert');
    expect(call.payload).toMatchObject({
      action: 'suspend',
      actor_user_id: OPERATOR,
      account_id: A,
      account_name: 'Company A',
      reason: 'chargebacks, ticket 88',
    });
    // `started_at` is left to the column default (`now()`), which is the
    // moment — and is not something the caller can backdate.
    expect(call.payload).not.toHaveProperty('started_at');
  });

  it('opens no session: a suspension carries no expiry at all', async () => {
    await recordPlatformAction({
      action: 'suspend',
      actorUserId: OPERATOR,
      accountId: A,
      accountName: 'Company A',
      reason: 'chargebacks, ticket 88',
    });
    // If this were a timestamp, `has_open_support_session` would have a
    // row to match on — a suspension that grants a read of the customer.
    expect(h.queries[0].payload?.expires_at).toBeNull();
  });

  it('snapshots the name, so the trail is readable after the account is gone', async () => {
    await recordPlatformAction({
      action: 'reactivate',
      actorUserId: OPERATOR,
      accountId: A,
      accountName: 'Company A',
      reason: 'refunded, ticket 88 closed',
    });
    expect(h.queries[0].payload?.account_name).toBe('Company A');
  });

  it('reports a failure instead of swallowing it', async () => {
    h.insertError = { message: 'connection reset' };
    expect(
      await recordPlatformAction({
        action: 'suspend',
        actorUserId: OPERATOR,
        accountId: A,
        accountName: 'Company A',
        reason: 'chargebacks, ticket 88',
      })
    ).toBeNull();
  });

  it('stores what the act needs to remember in details (071)', async () => {
    await recordPlatformAction({
      action: 'plan_override',
      actorUserId: OPERATOR,
      accountId: A,
      accountName: 'Company A',
      reason: 'comped: partner agreement 2026',
      details: {
        from_plan: 'pro',
        to_plan: 'negocio',
        from_provider: 'paypal',
      },
    });
    expect(h.queries[0].payload).toMatchObject({
      action: 'plan_override',
      account_id: A,
      details: {
        from_plan: 'pro',
        to_plan: 'negocio',
        from_provider: 'paypal',
      },
    });
  });

  it('writes an account_create row before the company exists, with no account', async () => {
    const id = await recordPlatformAction({
      action: 'account_create',
      actorUserId: OPERATOR,
      accountId: null,
      accountName: 'Acme',
      reason: 'new customer from the sales call',
      details: { owner_email: 'owner@acme.test' },
    });
    expect(id).toBe('log-new');
    expect(h.queries[0].payload).toMatchObject({
      action: 'account_create',
      account_id: null,
      account_name: 'Acme',
    });
  });

  it('defaults details to null for the acts that carry none', async () => {
    await recordPlatformAction({
      action: 'suspend',
      actorUserId: OPERATOR,
      accountId: A,
      accountName: 'Company A',
      reason: 'chargebacks, ticket 88',
    });
    expect(h.queries[0].payload?.details).toBeNull();
  });
});

describe('attachAccountToAuditRow', () => {
  it('fills the account of that row only, and only while it has none', async () => {
    h.rows.push(
      { id: 'log-1', account_id: null, action: 'account_create' },
      { id: 'log-2', account_id: B, action: 'account_create' }
    );
    await attachAccountToAuditRow('log-1', A);
    await attachAccountToAuditRow('log-2', A);

    expect(h.rows.find((r) => r.id === 'log-1')?.account_id).toBe(A);
    // Already pointed at a company: never re-pointed at another.
    expect(h.rows.find((r) => r.id === 'log-2')?.account_id).toBe(B);
    expect(h.queries[0].filters).toEqual([
      ['id', 'log-1'],
      ['account_id', null],
    ]);
  });

  it('agrees with the database about how short a reason may be', () => {
    // The CHECK of migrations 055/058 is `>= 10`. If this constant drifted
    // above it nothing would break; below it, every short reason the route
    // accepted would come back as a 500 from the insert.
    expect(MIN_REASON_LENGTH).toBeGreaterThanOrEqual(10);
  });
});

describe('loadAccountAudit', () => {
  it('returns the trail of one account, scoped by account_id (CP3)', async () => {
    h.rows.push(
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

    const trail = await loadAccountAudit(A);
    expect(trail.map((e) => e.id)).toEqual(['log-a']);
    expect(h.queries[0].filters).toEqual([['account_id', A]]);
  });

  it('carries the three kinds of row, not only the sessions', async () => {
    h.rows.push(
      {
        id: 'x',
        account_id: A,
        action: 'reactivate',
        actor_user_id: OPERATOR,
        reason: 'refunded, ticket 88 closed',
        started_at: '2026-09-03T00:00:00.000Z',
        ended_at: null,
        ended_reason: null,
      },
      {
        id: 'y',
        account_id: A,
        action: 'impersonation',
        actor_user_id: OPERATOR,
        reason: 'ticket 12: cannot send',
        started_at: '2026-09-04T00:00:00.000Z',
        ended_at: '2026-09-04T00:10:00.000Z',
        ended_reason: 'manual',
      }
    );
    const trail = await loadAccountAudit(A);
    expect(trail.map((e) => e.action).sort()).toEqual([
      'impersonation',
      'reactivate',
    ]);
    expect(trail.find((e) => e.id === 'y')?.endedReason).toBe('manual');
  });

  it('hands back the details of the s9.4 acts, and null for the older rows', async () => {
    h.rows.push(
      {
        id: 'p',
        account_id: A,
        action: 'plan_override',
        actor_user_id: OPERATOR,
        reason: 'comped: partner agreement 2026',
        started_at: '2026-09-05T00:00:00.000Z',
        ended_at: null,
        ended_reason: null,
        details: { from_plan: 'pro', to_plan: 'negocio' },
      },
      {
        id: 'q',
        account_id: A,
        action: 'suspend',
        actor_user_id: OPERATOR,
        reason: 'chargebacks, ticket 88',
        started_at: '2026-09-06T00:00:00.000Z',
        ended_at: null,
        ended_reason: null,
      }
    );
    const trail = await loadAccountAudit(A);
    expect(trail.find((e) => e.id === 'p')?.details).toEqual({
      from_plan: 'pro',
      to_plan: 'negocio',
    });
    expect(trail.find((e) => e.id === 'q')?.details).toBeNull();
  });

  it('throws rather than showing an empty trail for a failed read', async () => {
    h.selectError = { message: 'connection reset' };
    await expect(loadAccountAudit(A)).rejects.toBeTruthy();
  });
});
