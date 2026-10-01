import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// p11.4 (R12) — two overlapping cron invocations over the same pending
// row resume it once. The claim (`pending → running`, conditioned on
// `status = 'pending'`) is modelled against one shared row, the way
// Postgres would serialise the two UPDATEs.
const h = vi.hoisted(() => ({
  state: {
    rows: [] as Record<string, unknown>[],
    claimFilters: [] as [string, unknown][][],
  },
  resume: vi.fn(async () => {}),
}));

vi.mock('@/lib/automations/engine', () => ({
  resumePendingExecution: h.resume,
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      let update: Record<string, unknown> | null = null;
      const filters: [string, unknown][] = [];
      const b: Record<string, unknown> = {
        select: () => b,
        lte: () => b,
        order: () => b,
        eq: (c: string, v: unknown) => (filters.push([c, v]), b),
        update: (p: Record<string, unknown>) => ((update = p), b),
        // Due-rows read: a snapshot of what is pending right now.
        limit: () =>
          Promise.resolve({
            data: h.state.rows
              .filter((r) => r.status === 'pending')
              .map((r) => ({ ...r })),
            error: null,
          }),
        maybeSingle: () => {
          h.state.claimFilters.push([...filters]);
          const row = h.state.rows.find((r) =>
            filters.every(([c, v]) => r[c] === v)
          );
          if (!row || !update) {
            return Promise.resolve({ data: null, error: null });
          }
          Object.assign(row, update);
          return Promise.resolve({ data: { id: row.id }, error: null });
        },
      };
      return b;
    },
  }),
}));

import { GET } from './route';

function req(secret?: string) {
  return new Request('http://localhost/api/automations/cron', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

const ROW = {
  id: 'pe-1',
  automation_id: 'a1',
  account_id: 'acct-1',
  user_id: 'u1',
  contact_id: 'c1',
  log_id: 'log-1',
  parent_step_id: null,
  branch: null,
  next_step_position: 2,
  context: {},
  status: 'pending',
  run_at: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'cron-test-secret');
  h.state.rows = [{ ...ROW }];
  h.state.claimFilters = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/automations/cron (p11.4)', () => {
  it('R12 two concurrent runs over the same row resume it once', async () => {
    const [a, b] = await Promise.all([
      GET(req('cron-test-secret')),
      GET(req('cron-test-secret')),
    ]);
    const bodies = [await a.json(), await b.json()];
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pe-1', account_id: 'acct-1' })
    );
    expect(bodies.map((x) => x.processed).sort()).toEqual([0, 1]);
    // Both claims were conditioned on the row still being pending.
    expect(h.state.claimFilters).toHaveLength(2);
    for (const f of h.state.claimFilters) {
      expect(f).toEqual([
        ['id', 'pe-1'],
        ['status', 'pending'],
      ]);
    }
  });

  it('R12 a row already claimed by an earlier run is not resumed again', async () => {
    await GET(req('cron-test-secret'));
    const second = await GET(req('cron-test-secret'));
    expect(await second.json()).toEqual({ processed: 0 });
    expect(h.resume).toHaveBeenCalledTimes(1);
  });

  it('401 without the secret', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('401 with a wrong secret', async () => {
    const res = await GET(req('nope'));
    expect(res.status).toBe(401);
  });

  it('503 when AUTOMATION_CRON_SECRET is not set', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    const res = await GET(req('cron-test-secret'));
    expect(res.status).toBe(503);
    expect(h.resume).not.toHaveBeenCalled();
  });
});
