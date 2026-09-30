import { beforeEach, describe, expect, it, vi } from 'vitest';

// One account's support sessions and their actions (s9.5), read with the
// service role — so the isolation is ours to prove (CP3): with two
// companies seeded, the file of A shows A's and nothing of B's, and the
// other way round.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  queries: [] as { table: string; filters: [string, string, unknown][] }[],
  error: null as unknown,
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call = { table, filters: [] as [string, string, unknown][] };
      h.queries.push(call);
      const run = () => {
        if (h.error) return { data: null, error: h.error };
        const rows = (h.tables[table] ?? []).filter((row) =>
          call.filters.every(([op, col, value]) =>
            op === 'eq'
              ? row[col] === value
              : (value as unknown[]).includes(row[col])
          )
        );
        return { data: rows, error: null };
      };
      const builder = {
        select: () => builder,
        eq(col: string, value: unknown) {
          call.filters.push(['eq', col, value]);
          return builder;
        },
        in(col: string, values: unknown[]) {
          call.filters.push(['in', col, values]);
          return builder;
        },
        order: () => builder,
        limit: () => Promise.resolve(run()),
      };
      return builder;
    },
  }),
}));

const { loadSupportActivity } = await import('./support-activity');

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-09-30T12:00:00.000Z');

beforeEach(() => {
  h.error = null;
  h.queries = [];
  h.tables = {
    impersonation_log: [
      {
        id: 'log-a',
        account_id: A,
        action: 'impersonation',
        actor_user_id: OPERATOR,
        reason: 'ticket A: tags missing',
        started_at: '2026-09-30T11:50:00.000Z',
        expires_at: '2026-09-30T12:20:00.000Z',
        ended_at: null,
        ended_reason: null,
      },
      {
        id: 'hold-a',
        account_id: A,
        action: 'suspend',
        actor_user_id: OPERATOR,
        reason: 'chargebacks on three invoices',
        started_at: '2026-09-29T10:00:00.000Z',
        expires_at: null,
        ended_at: null,
        ended_reason: null,
      },
      {
        id: 'log-b',
        account_id: B,
        action: 'impersonation',
        actor_user_id: OPERATOR,
        reason: 'ticket B: broadcast stuck',
        started_at: '2026-09-28T09:00:00.000Z',
        expires_at: '2026-09-28T09:30:00.000Z',
        ended_at: '2026-09-28T09:10:00.000Z',
        ended_reason: 'manual',
      },
    ],
    impersonation_actions: [
      {
        id: 'act-a1',
        log_id: 'log-a',
        account_id: A,
        method: 'POST',
        path: '/api/quick-replies',
        status: null,
        source: 'http',
        occurred_at: '2026-09-30T11:55:00.000Z',
      },
      {
        id: 'act-a2',
        log_id: 'log-a',
        account_id: A,
        method: 'PATCH',
        path: 'db:contacts/c-1',
        status: null,
        source: 'db',
        occurred_at: '2026-09-30T11:56:00.000Z',
      },
      {
        id: 'act-b1',
        log_id: 'log-b',
        account_id: B,
        method: 'DELETE',
        path: 'db:broadcasts/x',
        status: null,
        source: 'db',
        occurred_at: '2026-09-28T09:05:00.000Z',
      },
      // A row that names A's session but B's account: it cannot come back
      // through the account filter, whatever the log id says.
      {
        id: 'act-forged',
        log_id: 'log-a',
        account_id: B,
        method: 'POST',
        path: '/api/forged',
        status: null,
        source: 'http',
        occurred_at: '2026-09-30T11:57:00.000Z',
      },
    ],
  };
});

describe('loadSupportActivity', () => {
  it("shows A's sessions and actions, and nothing of B's", async () => {
    const { sessions } = await loadSupportActivity(A, NOW);
    expect(sessions.map((s) => s.id)).toEqual(['log-a']);
    expect(sessions[0].actions.map((a) => a.id).sort()).toEqual([
      'act-a1',
      'act-a2',
    ]);
    expect(JSON.stringify(sessions)).not.toContain('ticket B');
    expect(JSON.stringify(sessions)).not.toContain('/api/forged');
  });

  it("and B's file shows B's, and nothing of A's", async () => {
    const { sessions } = await loadSupportActivity(B, NOW);
    expect(sessions.map((s) => s.id)).toEqual(['log-b']);
    expect(sessions[0].actions.map((a) => a.id)).toEqual(['act-b1']);
    expect(JSON.stringify(sessions)).not.toContain('ticket A');
  });

  it('scopes BOTH service-role queries by the account asked about (CP3)', async () => {
    await loadSupportActivity(A, NOW);
    expect(h.queries).toHaveLength(2);
    for (const q of h.queries) {
      expect(q.filters).toContainEqual(['eq', 'account_id', A]);
    }
    expect(h.queries[1].filters).toContainEqual(['in', 'log_id', ['log-a']]);
  });

  it('lists support sessions only, not suspensions', async () => {
    const { sessions } = await loadSupportActivity(A, NOW);
    expect(sessions.some((s) => s.id === 'hold-a')).toBe(false);
    expect(h.queries[0].filters).toContainEqual([
      'eq',
      'action',
      'impersonation',
    ]);
  });

  it('says which session is still in force', async () => {
    expect((await loadSupportActivity(A, NOW)).sessions[0].open).toBe(true);
    expect((await loadSupportActivity(B, NOW)).sessions[0].open).toBe(false);
    // Expired without anyone pressing "exit": not open either.
    const later = Date.parse('2026-09-30T13:00:00.000Z');
    expect((await loadSupportActivity(A, later)).sessions[0].open).toBe(false);
  });

  it('does not query the actions of an account with no sessions', async () => {
    const { sessions } = await loadSupportActivity(
      'cccccccc-0000-4000-8000-00000000000c',
      NOW
    );
    expect(sessions).toEqual([]);
    expect(h.queries).toHaveLength(1);
  });

  it('throws on a database error instead of showing an empty trail', async () => {
    h.error = { message: 'down' };
    await expect(loadSupportActivity(A, NOW)).rejects.toEqual({
      message: 'down',
    });
  });
});
