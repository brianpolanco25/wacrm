import { beforeEach, describe, expect, it, vi } from 'vitest';

// /api/platform/impersonate — the whole criterion "toda impersonación queda
// registrada con actor, cuenta, momento y motivo", plus the guard that
// makes the prefix worth having.

interface LogRow {
  id: string;
  actor_user_id: string;
  account_id: string;
  account_name: string | null;
  reason: string;
  started_at: string;
  expires_at: string;
  ended_at?: string | null;
  ended_reason?: string | null;
}

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  accounts: new Map<string, { id: string; name: string }>(),
  log: [] as Record<string, unknown>[],
  /** Every service-role query, so the account scope can be asserted. */
  queries: [] as {
    table: string;
    op: string;
    filters: [string, unknown][];
    payload?: Record<string, unknown>;
  }[],
  cookies: new Map<string, string>(),
  insertError: null as unknown,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      h.cookies.has(name) ? { name, value: h.cookies.get(name) } : undefined,
    set: (name: string, value: string) => h.cookies.set(name, value),
    delete: (name: string) => h.cookies.delete(name),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call = {
        table,
        op: 'select',
        filters: [] as [string, unknown][],
        payload: undefined as Record<string, unknown> | undefined,
      };
      h.queries.push(call);

      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        is(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        async maybeSingle() {
          if (table === 'platform_admins') {
            const [, userId] =
              call.filters.find(([c]) => c === 'user_id') ?? [];
            return {
              data: h.admins.has(userId as string)
                ? { user_id: userId, granted_at: null, note: null }
                : null,
              error: null,
            };
          }
          if (table === 'accounts') {
            const [, id] = call.filters.find(([c]) => c === 'id') ?? [];
            return { data: h.accounts.get(id as string) ?? null, error: null };
          }
          if (table === 'impersonation_log') {
            // The "is this row still open?" lookup of
            // `isSupportSessionOpen`, matched on every filter it sets.
            const row = h.log.find((r) =>
              call.filters.every(([c, v]) =>
                v === null ? r[c] == null : r[c] === v
              )
            );
            return { data: row ?? null, error: null };
          }
          return { data: null, error: null };
        },
        insert(payload: Record<string, unknown>) {
          call.op = 'insert';
          call.payload = payload;
          if (h.insertError) {
            return Promise.resolve({ data: null, error: h.insertError });
          }
          h.log.push({ ...payload, ended_at: null, ended_reason: null });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: Record<string, unknown>) {
          call.op = 'update';
          call.payload = patch;
          const apply = () => {
            const touched: Record<string, unknown>[] = [];
            for (const row of h.log) {
              const matches = call.filters.every(([c, v]) => {
                // `lt:` marks the strict-less-than filters of the expiry
                // sweep; everything else is equality / is-null.
                if (c.startsWith('lt:')) {
                  const column = c.slice(3);
                  return (
                    typeof row[column] === 'string' &&
                    (row[column] as string) < (v as string)
                  );
                }
                return v === null ? row[c] == null : row[c] === v;
              });
              if (matches) {
                Object.assign(row, patch);
                touched.push(row);
              }
            }
            return touched;
          };
          const runner = {
            eq(column: string, value: unknown) {
              call.filters.push([column, value]);
              return runner;
            },
            is(column: string, value: unknown) {
              call.filters.push([column, value]);
              return runner;
            },
            lt(column: string, value: unknown) {
              call.filters.push([`lt:${column}`, value]);
              return runner;
            },
            select() {
              const rows = apply();
              return Promise.resolve({ data: rows, error: null });
            },
            then(onFulfilled: (r: { error: null }) => unknown) {
              apply();
              return Promise.resolve({ error: null }).then(onFulfilled);
            },
          };
          return runner;
        },
      };
      return builder;
    },
  }),
}));

const { GET, POST } = await import('./route');
const { POST: STOP } = await import('./stop/route');
const { SUPPORT_ACTIVE_COOKIE, SUPPORT_COOKIE, verifySupportSession } =
  await import('@/lib/auth/impersonation');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACCOUNT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const REASON = 'ticket 1234: the customer cannot see their broadcasts';

function req(body: unknown): Request {
  return new Request('https://app.test/api/platform/impersonate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function logRows(): LogRow[] {
  return h.log as unknown as LogRow[];
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.accounts = new Map([
    [ACCOUNT_A, { id: ACCOUNT_A, name: 'Customer A' }],
    [ACCOUNT_B, { id: ACCOUNT_B, name: 'Customer B' }],
  ]);
  h.log = [];
  h.queries = [];
  h.cookies = new Map();
  h.insertError = null;
});

// ============================================================
// The guard
// ============================================================

describe('the platform prefix is closed to everyone but platform admins', () => {
  it('401s an anonymous caller on every verb', async () => {
    h.user = null;
    expect((await GET()).status).toBe(401);
    expect(
      (await POST(req({ account_id: ACCOUNT_A, reason: REASON }))).status
    ).toBe(401);
    expect((await STOP()).status).toBe(401);
  });

  it('403s a company owner who is not in platform_admins, on every verb', async () => {
    // The criterion "un owner normal no ve más que la suya": there is no
    // route here that will tell them anything about another company.
    h.user = { id: PLAIN_OWNER };

    expect((await GET()).status).toBe(403);
    expect(
      (await POST(req({ account_id: ACCOUNT_A, reason: REASON }))).status
    ).toBe(403);
    expect((await STOP()).status).toBe(403);
  });

  it('leaks nothing about the target account in the 403 body', async () => {
    h.user = { id: PLAIN_OWNER };
    const res = await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('Customer A');
    expect(JSON.stringify(body)).not.toContain(ACCOUNT_A);
  });

  it('writes nothing to the bitácora for a refused caller', async () => {
    h.user = { id: PLAIN_OWNER };
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    expect(h.log).toEqual([]);
    expect(h.cookies.has(SUPPORT_COOKIE)).toBe(false);
  });
});

// ============================================================
// Opening a session
// ============================================================

describe('POST /api/platform/impersonate', () => {
  it('refuses without a reason', async () => {
    const res = await POST(req({ account_id: ACCOUNT_A }));
    expect(res.status).toBe(400);
    expect(h.log).toEqual([]);
  });

  it('refuses a reason too short to mean anything', async () => {
    // "ok" in the reason column is the same as no audit trail at all.
    const res = await POST(req({ account_id: ACCOUNT_A, reason: 'ok' }));
    expect(res.status).toBe(400);
    const res2 = await POST(
      req({ account_id: ACCOUNT_A, reason: '          ' })
    );
    expect(res2.status).toBe(400);
    expect(h.log).toEqual([]);
  });

  it('refuses a missing or malformed account_id', async () => {
    expect((await POST(req({ reason: REASON }))).status).toBe(400);
    expect(
      (await POST(req({ account_id: 'nope', reason: REASON }))).status
    ).toBe(400);
  });

  it('refuses invalid JSON', async () => {
    const res = await POST(
      new Request('https://app.test/api/platform/impersonate', {
        method: 'POST',
        body: 'not json',
      })
    );
    expect(res.status).toBe(400);
  });

  it('404s an account that does not exist, without opening a session', async () => {
    const res = await POST(
      req({
        account_id: 'dddddddd-0000-4000-8000-00000000dead',
        reason: REASON,
      })
    );
    expect(res.status).toBe(404);
    expect(h.cookies.has(SUPPORT_COOKIE)).toBe(false);
  });

  it('records actor, account, moment and reason, and only then hands out the cookie', async () => {
    const res = await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    expect(res.status).toBe(200);

    expect(logRows()).toHaveLength(1);
    const row = logRows()[0];
    expect(row.actor_user_id).toBe(OPERATOR);
    expect(row.account_id).toBe(ACCOUNT_A);
    expect(row.account_name).toBe('Customer A');
    expect(row.reason).toBe(REASON);
    expect(Date.parse(row.started_at)).not.toBeNaN();
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now());
    expect(row.ended_at).toBeNull();

    const token = h.cookies.get(SUPPORT_COOKIE)!;
    const session = verifySupportSession(token);
    expect(session).toMatchObject({
      logId: row.id,
      actorUserId: OPERATOR,
      accountId: ACCOUNT_A,
    });
  });

  it('trims the reason before storing it', async () => {
    await POST(req({ account_id: ACCOUNT_A, reason: `  ${REASON}  ` }));
    expect(logRows()[0].reason).toBe(REASON);
  });

  it('opens no session at all when the bitácora insert fails', async () => {
    // An unlogged impersonation is the single outcome this feature exists
    // to prevent, so a failure to record it is a failure to start.
    h.insertError = { message: 'constraint violation' };
    const res = await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    expect(res.status).toBe(500);
    expect(h.cookies.has(SUPPORT_COOKIE)).toBe(false);
  });

  it('tells the browser bundle there is a session, in a cookie it can read', async () => {
    // Most of this panel queries Supabase from the browser, where the
    // httpOnly token is invisible. This flag is how those code paths learn
    // to refuse writes (`@/lib/supabase/client`).
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    expect(h.cookies.get(SUPPORT_ACTIVE_COOKIE)).toBe('1');

    await STOP();
    expect(h.cookies.has(SUPPORT_ACTIVE_COOKIE)).toBe(false);
  });

  it('closes the bitácora row when the cookie cannot be issued', async () => {
    // `signingKey()` refuses a malformed ENCRYPTION_KEY — after the row is
    // already committed. Left uncaught this was a 500 plus a row open
    // forever: nobody would hold the cookie that names it, so nothing
    // could ever close it.
    const key = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'not-64-hex-characters';
    try {
      const res = await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
      expect(res.status).toBe(500);
      expect(h.cookies.has(SUPPORT_COOKIE)).toBe(false);
      expect(h.cookies.has(SUPPORT_ACTIVE_COOKIE)).toBe(false);
      // The row is there — the attempt IS auditable — and it is closed.
      expect(logRows()).toHaveLength(1);
      expect(logRows()[0].ended_reason).toBe('expired');
      expect(logRows()[0].ended_at).toBeTruthy();
    } finally {
      process.env.ENCRYPTION_KEY = key;
    }
  });

  it('closes the previous session before opening another, so the log never overlaps', async () => {
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    await POST(
      req({ account_id: ACCOUNT_B, reason: 'ticket 9999: billing question' })
    );

    expect(logRows()).toHaveLength(2);
    const [first, second] = logRows();
    expect(first.account_id).toBe(ACCOUNT_A);
    expect(first.ended_reason).toBe('superseded');
    expect(first.ended_at).toBeTruthy();
    expect(second.account_id).toBe(ACCOUNT_B);
    expect(second.ended_at).toBeNull();
  });

  it('scopes every service-role query by the account it is about', async () => {
    // CP3 by hand, on this route: the reads are by `accounts.id` (which IS
    // the account scope) and the writes carry / filter on `account_id`.
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));

    const unscoped = h.queries.filter((q) => {
      if (q.op === 'insert') return typeof q.payload?.account_id !== 'string';
      if (q.table === 'accounts') return !q.filters.some(([c]) => c === 'id');
      if (q.table === 'platform_admins') return false; // keyed by the caller's own uid
      // The expiry sweep is cross-account BY DESIGN: it closes rows that
      // ran out of time whoever opened them, writes nothing but `ended_at`
      // on the platform's own bitácora, and touches no customer data.
      if (
        q.table === 'impersonation_log' &&
        q.filters.some(([c]) => c === 'lt:expires_at')
      ) {
        return false;
      }
      return !q.filters.some(([c]) => c === 'account_id');
    });
    expect(unscoped).toEqual([]);
  });
});

// ============================================================
// Inspecting and closing
// ============================================================

describe('GET /api/platform/impersonate', () => {
  it('reports no session when there is no cookie', async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ session: null });
  });

  it('reports the open session with the account it is looking at', async () => {
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    const res = await GET();
    const body = await res.json();
    expect(body.session).toMatchObject({
      account_id: ACCOUNT_A,
      account_name: 'Customer A',
    });
  });

  it('closes the bitácora row and drops the cookie once the session has expired', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
      // Well past the 30-minute window.
      vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));

      const res = await GET();
      expect(await res.json()).toEqual({ session: null });
      expect(logRows()[0].ended_reason).toBe('expired');
      expect(h.cookies.has(SUPPORT_COOKIE)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a cookie signed for a different operator', async () => {
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    // Another platform admin, same browser jar.
    h.user = { id: PLAIN_OWNER };
    h.admins.add(PLAIN_OWNER);

    const res = await GET();
    expect(await res.json()).toEqual({ session: null });
    // …and the first operator's row is left alone, not closed by someone else.
    expect(logRows()[0].ended_at).toBeNull();
  });
});

describe('the expiry sweep', () => {
  it('closes rows nobody came back for, on the paths an operator uses', async () => {
    // The common ending is "the operator shut the browser", and then no
    // request ever names that row again. Somebody else opening or closing
    // a session is the moment to tidy up.
    h.log.push({
      id: 'abandoned',
      actor_user_id: PLAIN_OWNER,
      account_id: ACCOUNT_B,
      account_name: 'Customer B',
      reason: REASON,
      started_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-01T00:30:00.000Z',
      ended_at: null,
      ended_reason: null,
    });

    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));

    const abandoned = logRows().find((r) => r.id === 'abandoned')!;
    expect(abandoned.ended_reason).toBe('expired');
    expect(abandoned.ended_at).toBeTruthy();
  });

  it('leaves a session that is still running alone', async () => {
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    await GET();
    expect(logRows()[0].ended_at).toBeNull();
  });
});

describe('POST /api/platform/impersonate/stop', () => {
  it('closes the row as a manual exit and clears the cookie', async () => {
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    const res = await STOP();

    expect(res.status).toBe(200);
    expect(logRows()[0].ended_reason).toBe('manual');
    expect(Date.parse(logRows()[0].ended_at as string)).not.toBeNaN();
    expect(h.cookies.has(SUPPORT_COOKIE)).toBe(false);
  });

  it('is idempotent — pressing exit twice is a 200, not an error', async () => {
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    await STOP();
    const again = await STOP();
    expect(again.status).toBe(200);
    expect(logRows()[0].ended_reason).toBe('manual');
  });

  it('scopes the closing update by the row id AND its account', async () => {
    await POST(req({ account_id: ACCOUNT_A, reason: REASON }));
    h.queries = [];
    await STOP();

    const update = h.queries.find(
      (q) => q.table === 'impersonation_log' && q.op === 'update'
    );
    expect(update?.filters).toEqual(
      expect.arrayContaining([
        ['id', logRows()[0].id],
        ['account_id', ACCOUNT_A],
      ])
    );
  });
});
