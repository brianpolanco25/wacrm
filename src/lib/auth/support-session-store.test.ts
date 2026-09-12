import { beforeEach, describe, expect, it, vi } from 'vitest';

// The bitácora row as the source of truth: "is this session still open?"
// and "close everything that ran out of time". Both are service-role
// queries, so the shape of the query is as much the subject here as the
// answer it gives.

interface Row extends Record<string, unknown> {
  id: string;
  actor_user_id: string;
  account_id: string;
  /** Migration 058: this bitácora also records suspend / reactivate. */
  action: string;
  expires_at: string | null;
  ended_at: string | null;
  ended_reason?: string | null;
}

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  queries: [] as {
    table: string;
    op: string;
    filters: [string, unknown][];
    patch?: Record<string, unknown>;
  }[],
  error: null as unknown,
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call = {
        table,
        op: 'select',
        filters: [] as [string, unknown][],
        patch: undefined as Record<string, unknown> | undefined,
      };
      h.queries.push(call);

      const matches = (row: Record<string, unknown>) =>
        call.filters.every(([c, v]) => {
          if (c.startsWith('lt:')) {
            return (row[c.slice(3)] as string) < (v as string);
          }
          return v === null ? row[c] == null : row[c] === v;
        });

      const builder = {
        select() {
          if (call.op === 'update') {
            const touched = h.rows.filter(matches);
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
        is(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        lt(column: string, value: unknown) {
          call.filters.push([`lt:${column}`, value]);
          return builder;
        },
        update(patch: Record<string, unknown>) {
          call.op = 'update';
          call.patch = patch;
          return builder;
        },
        async maybeSingle() {
          if (h.error) return { data: null, error: h.error };
          return { data: h.rows.find(matches) ?? null, error: null };
        },
      };
      return builder;
    },
  }),
}));

const { isSupportSessionOpen, sweepExpiredSupportSessions } =
  await import('./support-session-store');

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACCOUNT_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const SESSION = { logId: 'log-1', accountId: ACCOUNT_A, actorUserId: ACTOR };

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'log-1',
    actor_user_id: ACTOR,
    account_id: ACCOUNT_A,
    action: 'impersonation',
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    ended_at: null,
    ...over,
  };
}

beforeEach(() => {
  h.rows = [];
  h.queries = [];
  h.error = null;
});

describe('isSupportSessionOpen', () => {
  it('says yes for an open row that has not run out of time', async () => {
    h.rows = [row()];
    expect(await isSupportSessionOpen(SESSION)).toBe(true);
  });

  it('says no once the row is closed — this is what "exit" revokes', async () => {
    h.rows = [row({ ended_at: new Date().toISOString() })];
    expect(await isSupportSessionOpen(SESSION)).toBe(false);
  });

  it("says no past the ROW's own deadline, not the cookie's", async () => {
    // The cookie's deadline is inside the token its holder can edit; this
    // one is not.
    h.rows = [row({ expires_at: new Date(Date.now() - 1000).toISOString() })];
    expect(await isSupportSessionOpen(SESSION)).toBe(false);
  });

  it('says no for a row belonging to another actor or another account', async () => {
    h.rows = [row({ actor_user_id: OTHER })];
    expect(await isSupportSessionOpen(SESSION)).toBe(false);

    h.rows = [row({ account_id: ACCOUNT_B })];
    expect(await isSupportSessionOpen(SESSION)).toBe(false);
  });

  it('scopes the lookup by account, actor AND row id (CP3)', async () => {
    h.rows = [row()];
    await isSupportSessionOpen(SESSION);

    const [query] = h.queries;
    expect(query.table).toBe('impersonation_log');
    expect(query.filters).toEqual(
      expect.arrayContaining([
        ['id', 'log-1'],
        ['account_id', ACCOUNT_A],
        ['actor_user_id', ACTOR],
        ['action', 'impersonation'],
        ['ended_at', null],
      ])
    );
  });

  it('never reads a suspend row as a session (migration 058)', async () => {
    // The platform bitácora holds three kinds of row now. A suspension
    // has no expiry at all, so "expires_at > now()" would not save us if
    // someone ever wrote one with a date — the `action` filter does.
    h.rows = [row({ action: 'suspend', expires_at: null })];
    expect(await isSupportSessionOpen(SESSION)).toBe(false);

    h.rows = [
      row({
        action: 'suspend',
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    ];
    expect(await isSupportSessionOpen(SESSION)).toBe(false);
  });

  it('fails closed when the database errors', async () => {
    h.rows = [row()];
    h.error = { message: 'connection reset' };
    expect(await isSupportSessionOpen(SESSION)).toBe(false);
  });
});

describe('sweepExpiredSupportSessions', () => {
  it('closes the rows nobody came back to close', async () => {
    // The common ending: the operator shut the browser instead of
    // pressing exit, so no request ever names that row again.
    h.rows = [
      row({
        id: 'stale',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    ];

    expect(await sweepExpiredSupportSessions()).toBe(1);
    expect(h.rows[0].ended_reason).toBe('expired');
    expect(h.rows[0].ended_at).toBeTruthy();
  });

  it('leaves a live session and an already-closed row alone', async () => {
    h.rows = [
      row({ id: 'live' }),
      row({
        id: 'closed',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        ended_at: '2026-01-01T00:00:00.000Z',
        ended_reason: 'manual',
      }),
    ];

    expect(await sweepExpiredSupportSessions()).toBe(0);
    expect(h.rows[0].ended_at).toBeNull();
    expect(h.rows[1].ended_reason).toBe('manual');
  });

  it('filters on the deadline and on being open, and nothing else', async () => {
    // Deliberately cross-account — that is the whole job — and therefore
    // waived by name in `tenant-isolation.test.ts`. The assertion here is
    // that it cannot become a wider UPDATE by accident.
    await sweepExpiredSupportSessions();
    const [query] = h.queries;
    expect(query.op).toBe('update');
    expect(query.filters.map(([c]) => c).sort()).toEqual([
      'action',
      'ended_at',
      'lt:expires_at',
    ]);
    expect(Object.keys(query.patch ?? {}).sort()).toEqual([
      'ended_at',
      'ended_reason',
    ]);
  });

  it('leaves the suspend / reactivate rows of 058 alone', async () => {
    // They carry no deadline, so there is nothing to expire — and a
    // sweep that closed them would rewrite the record of a suspension
    // that is still in force.
    h.rows = [
      row({ id: 'held', action: 'suspend', expires_at: null }),
      row({ id: 'freed', action: 'reactivate', expires_at: null }),
    ];

    expect(await sweepExpiredSupportSessions()).toBe(0);
    expect(h.rows[0].ended_at).toBeNull();
    expect(h.rows[1].ended_at).toBeNull();
  });

  it('reports zero and does not throw when the sweep fails', async () => {
    h.error = { message: 'nope' };
    expect(await sweepExpiredSupportSessions()).toBe(0);
  });
});
