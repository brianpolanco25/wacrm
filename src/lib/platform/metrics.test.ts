import { describe, expect, it } from 'vitest';

import { parsePlatformMetrics } from './metrics';

// The jsonb of `platform_metrics()` (migration 069) turned into what the
// Resumen renders. The SQL itself — MRR = 200 with a monthly 100 and a
// yearly 1200, comped outside it, `authenticated` refused — is checked
// against a real Postgres in progress/checks_platform-dashboard.sql.

describe('parsePlatformMetrics', () => {
  it('reads numeric strings as numbers (Postgres numeric can arrive as text)', () => {
    const m = parsePlatformMetrics({
      revenue: { mrr_usd: '200.00', arr_usd: '2400.00', paying_accounts: '3' },
    });
    expect(m.revenue).toEqual({ mrrUsd: 200, arrUsd: 2400, payingAccounts: 3 });
  });

  it('turns a missing or malformed payload into zeros, not NaN or a throw', () => {
    for (const raw of [null, undefined, 'nope', [], {}]) {
      const m = parsePlatformMetrics(raw);
      expect(m.accounts).toEqual({ total: 0, byStatus: {} });
      expect(m.revenue).toEqual({ mrrUsd: 0, arrUsd: 0, payingAccounts: 0 });
      expect(m.signups.weekly).toEqual([]);
      expect(m.generatedAt).toBeNull();
      expect(m.messagesMonth.periodStart).toBeNull();
    }
  });

  it('keeps every status key, including `none` and ones it has never seen', () => {
    const m = parsePlatformMetrics({
      accounts: {
        total: 6,
        by_status: { active: 2, none: 1, incomplete: 3 },
      },
    });
    expect(m.accounts.byStatus).toEqual({ active: 2, none: 1, incomplete: 3 });
  });

  it('keeps the weekly series in order and drops entries with no week', () => {
    const m = parsePlatformMetrics({
      signups: {
        weekly: [
          { week_start: '2026-09-21', count: 2 },
          { count: 9 },
          { week_start: '2026-09-28', count: '4' },
        ],
      },
    });
    expect(m.signups.weekly).toEqual([
      { weekStart: '2026-09-21', count: 2 },
      { weekStart: '2026-09-28', count: 4 },
    ]);
  });

  it('keeps comped apart from the revenue', () => {
    const m = parsePlatformMetrics({
      comped: 1,
      revenue: { mrr_usd: 0, arr_usd: 0, paying_accounts: 0 },
    });
    expect(m.comped).toBe(1);
    expect(m.revenue.mrrUsd).toBe(0);
  });
});
