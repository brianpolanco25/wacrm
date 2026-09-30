// ============================================================
// The numbers behind the operator's Resumen (s9.2, `/platform`).
//
// ISOLATION — the same documented exception as `listAccounts`
// ------------------------------------------------------------
// This runs with the SERVICE ROLE and is cross-account BY DEFINITION:
// «how many companies do we have, and what do they pay us» has no
// account to scope it by. What bounds it instead:
//
//   - it goes through `platform_metrics()` (migration 069), granted to
//     `service_role` and to nobody else, and not SECURITY DEFINER;
//   - it returns aggregates only — counts and sums, never an account id,
//     a name or a row;
//   - its only caller is `GET /api/platform/metrics`, behind
//     `requirePlatformAdmin()`.
//
// The jsonb is normalised here (snake_case → camelCase, every number
// coerced and defaulted) so the UI never has to guess whether a missing
// key means zero.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';

export interface WeeklySignups {
  /** Monday of the week, `YYYY-MM-DD` (UTC). */
  weekStart: string;
  count: number;
}

export interface PlatformMetrics {
  generatedAt: string | null;
  accounts: {
    total: number;
    /** One key per `subscriptions.status`, plus `none` for no row. */
    byStatus: Record<string, number>;
  };
  signups: {
    last7Days: number;
    last30Days: number;
    /** Oldest first; the last entry is the current week. */
    weekly: WeeklySignups[];
  };
  revenue: {
    /** USD. Comped (`provider = 'manual'`) accounts are NOT in here. */
    mrrUsd: number;
    arrUsd: number;
    payingAccounts: number;
  };
  /** Accounts on a manual (`provider = 'manual'`) live subscription. */
  comped: number;
  delinquent: { pastDue: number; suspended: number; total: number };
  whatsapp: { connected: number };
  messagesMonth: {
    /** First day of the calendar month the counts cover. */
    periodStart: string | null;
    inbound: number;
    outbound: number;
  };
}

function num(value: unknown): number {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? n : 0;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Normalise the jsonb of `platform_metrics()`. Pure; exported for tests. */
export function parsePlatformMetrics(raw: unknown): PlatformMetrics {
  const root = obj(raw);
  const accounts = obj(root.accounts);
  const signups = obj(root.signups);
  const revenue = obj(root.revenue);
  const delinquent = obj(root.delinquent);
  const whatsapp = obj(root.whatsapp);
  const messages = obj(root.messages_month);

  const byStatus: Record<string, number> = {};
  for (const [status, n] of Object.entries(obj(accounts.by_status))) {
    byStatus[status] = num(n);
  }

  const weekly: WeeklySignups[] = Array.isArray(signups.weekly)
    ? signups.weekly.flatMap((entry) => {
        const e = obj(entry);
        const weekStart = str(e.week_start);
        return weekStart ? [{ weekStart, count: num(e.count) }] : [];
      })
    : [];

  return {
    generatedAt: str(root.generated_at),
    accounts: { total: num(accounts.total), byStatus },
    signups: {
      last7Days: num(signups.last_7_days),
      last30Days: num(signups.last_30_days),
      weekly,
    },
    revenue: {
      mrrUsd: num(revenue.mrr_usd),
      arrUsd: num(revenue.arr_usd),
      payingAccounts: num(revenue.paying_accounts),
    },
    comped: num(root.comped),
    delinquent: {
      pastDue: num(delinquent.past_due),
      suspended: num(delinquent.suspended),
      total: num(delinquent.total),
    },
    whatsapp: { connected: num(whatsapp.connected) },
    messagesMonth: {
      periodStart: str(messages.period_start),
      inbound: num(messages.inbound),
      outbound: num(messages.outbound),
    },
  };
}

/** One round trip: every figure of the Resumen. */
export async function loadPlatformMetrics(): Promise<PlatformMetrics> {
  const { data, error } = await supabaseAdmin().rpc('platform_metrics');
  if (error) {
    throw new Error(`platform_metrics failed: ${error.message}`);
  }
  return parsePlatformMetrics(data);
}
