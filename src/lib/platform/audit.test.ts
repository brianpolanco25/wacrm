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
        insert(payload: Record<string, unknown>) {
          call.op = 'insert';
          call.payload = payload;
          if (h.insertError) {
            return Promise.resolve({ data: null, error: h.insertError });
          }
          h.rows.push({ ...payload });
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  }),
}));

const { recordPlatformAction, loadAccountAudit, MIN_REASON_LENGTH } =
  await import('./audit');

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
    ).toBe(true);

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
    ).toBe(false);
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

  it('throws rather than showing an empty trail for a failed read', async () => {
    h.selectError = { message: 'connection reset' };
    await expect(loadAccountAudit(A)).rejects.toBeTruthy();
  });
});
