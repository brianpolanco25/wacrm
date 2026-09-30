import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/platform/metrics — the Resumen of the operator console (s9.2).
// The guard (401 / 403 before the function runs) and the shape of what
// an operator gets back. The service-role client is mocked at the edge:
// `from('platform_admins')` answers the guard, `rpc()` records what was
// asked of the database.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  rpcCalls: [] as { fn: string; args: unknown }[],
  rpcResult: { data: null as unknown, error: null as unknown },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: (_c: string, userId: string) => ({
          maybeSingle: async () => ({
            data: h.admins.has(userId)
              ? { user_id: userId, granted_at: null, note: null }
              : null,
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (fn: string, args?: unknown) => {
      h.rpcCalls.push({ fn, args });
      return h.rpcResult;
    },
  }),
}));

const { GET } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';

/** What `platform_metrics()` returns (migration 069), verbatim. */
const RAW = {
  generated_at: '2026-09-30T12:00:00+00:00',
  accounts: { total: 7, by_status: { active: 3, past_due: 1, none: 3 } },
  signups: {
    last_7_days: 2,
    last_30_days: 5,
    weekly: Array.from({ length: 12 }, (_, i) => ({
      week_start: `2026-07-${String(6 + i).padStart(2, '0')}`,
      count: i,
    })),
  },
  revenue: { mrr_usd: 200.0, arr_usd: 2400.0, paying_accounts: 3 },
  comped: 1,
  delinquent: { past_due: 1, suspended: 2, total: 3 },
  whatsapp: { connected: 4 },
  messages_month: { period_start: '2026-09-01', inbound: 120, outbound: 80 },
};

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.rpcCalls = [];
  h.rpcResult = { data: RAW, error: null };
});

describe('GET /api/platform/metrics — the guard', () => {
  it('401s a visitor with no session, and never asks the database', async () => {
    h.user = null;
    const res = await GET();
    expect(res.status).toBe(401);
    expect(h.rpcCalls).toEqual([]);
  });

  it('403s a company owner without filtering anything', async () => {
    h.user = { id: PLAIN_OWNER };
    const res = await GET();
    expect(res.status).toBe(403);
    // The function never ran, so there is nothing to have filtered.
    expect(h.rpcCalls).toEqual([]);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/mrr|account|revenue|signup/i);
  });
});

describe('GET /api/platform/metrics — an operator', () => {
  it('200s with the Resumen, from ONE call to platform_metrics()', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(h.rpcCalls).toEqual([{ fn: 'platform_metrics', args: undefined }]);

    const body = await res.json();
    expect(body).toEqual({
      generatedAt: '2026-09-30T12:00:00+00:00',
      accounts: { total: 7, byStatus: { active: 3, past_due: 1, none: 3 } },
      signups: {
        last7Days: 2,
        last30Days: 5,
        weekly: RAW.signups.weekly.map((w) => ({
          weekStart: w.week_start,
          count: w.count,
        })),
      },
      revenue: { mrrUsd: 200, arrUsd: 2400, payingAccounts: 3 },
      comped: 1,
      delinquent: { pastDue: 1, suspended: 2, total: 3 },
      whatsapp: { connected: 4 },
      messagesMonth: { periodStart: '2026-09-01', inbound: 120, outbound: 80 },
    });
    expect(body.signups.weekly).toHaveLength(12);
  });

  it('500s, without the database error, when the function fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rpcResult = {
      data: null,
      error: { message: 'permission denied for function platform_metrics' },
    };
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/permission denied/);
    spy.mockRestore();
  });
});
