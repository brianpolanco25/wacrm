// ============================================================
// Enforcement — where the entitlements of fase 0 finally bite.
//
// `entitlements.ts` (f0.3) answers "what is this account allowed to
// do?" and was deliberately left uncalled. This module is the fase 3
// §4/§5 wiring: the eight enforcement points of the spec all go
// through the four asserts below, and every one of them counts with
// `increment_usage` only AFTER the action succeeded — counting before
// would inflate the bill with failed attempts.
//
// Two kinds of limit, and they are not interchangeable:
//
//   FLOW limits  (`messages_out`, `ai_replies`, `broadcast_recipients`)
//     accumulate over the calendar month in `usage_counters`. Checked
//     with `assertQuota` (entitlements.ts) and incremented with
//     `recordUsage`.
//
//   STOCK limits (`operators`, `numbers`, `knowledge_documents`) are a
//     headcount of rows that exist right now. They are NOT counters:
//     deleting a knowledge document gives the seat back, and
//     `usage_counters` — which only ever goes up — would say otherwise.
//     Checked with `assertStockLimit` against a live `count`, never
//     incremented.
//
//     `plans` also carries a `contacts` cap, and §4 does NOT list a
//     point that applies it — no `assertStockLimit(…, 'contacts', …)`
//     exists anywhere. It is deliberately absent rather than forgotten:
//     do not read this module as covering it.
//
// §5, the dunning ladder, lives in `assertWritable`: a `suspended` (or
// `expired`, or `past_due` past its grace) account behaves as if every
// member were a `viewer`. Nothing writes to `profiles.account_role`,
// so reactivating restores the real roles by itself.
//
// Isolation: every read here goes through the service-role client and
// is filtered by `account_id` by hand. RLS is not in play.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client';

import {
  assertQuota,
  getEntitlements,
  hasFeature,
  QuotaExceededError,
  FeatureNotAvailableError,
  type Entitlements,
} from './entitlements';

// Re-exported so an enforcement site imports one module: the flow
// limits (`messages_out`, `ai_replies`, `broadcast_recipients`) are
// checked with `assertQuota` exactly as f0.3 wrote it, and the two
// errors it can raise travel with it.
export {
  assertQuota,
  getEntitlements,
  QuotaExceededError,
  FeatureNotAvailableError,
};

/** Where the UI sends someone to fix a billing problem. */
export const BILLING_UPGRADE_PATH = '/billing';

/**
 * The account may only read: the subscription is suspended/expired, or
 * past due with the grace period spent. 403, not 402 — the caller is
 * authenticated and the action exists, they just have no write rights
 * right now (exactly what a `viewer` gets).
 */
export class AccountLockedError extends Error {
  readonly status = 403 as const;
  readonly code = 'account_read_only' as const;
  readonly subscriptionStatus: string;

  constructor(subscriptionStatus: string) {
    super(
      `This account is read-only while its subscription is '${subscriptionStatus}'. Settle the subscription to write again.`
    );
    this.name = 'AccountLockedError';
    this.subscriptionStatus = subscriptionStatus;
  }
}

/**
 * A stock limit (seats, numbers, documents) is full. Separate class
 * from `QuotaExceededError` because there is no period to wait out:
 * the answer is "upgrade or free one up", not "come back next month".
 */
export class PlanLimitError extends Error {
  readonly status = 402 as const;
  readonly code = 'plan_limit_reached' as const;
  readonly metric: string;
  readonly limit: number;
  readonly used: number;

  constructor(metric: string, limit: number, used: number) {
    super(
      `Your plan allows ${limit} ${metric} and ${used} are already in use. Upgrade the plan to raise this limit.`
    );
    this.name = 'PlanLimitError';
    this.metric = metric;
    this.limit = limit;
    this.used = used;
  }
}

// ------------------------------------------------------------
// Wire shape
// ------------------------------------------------------------

export interface BillingErrorPayload {
  error: string;
  code: string;
  /** Always `/billing` — "how do I raise this?" in one field. */
  upgradeUrl: string;
  metric?: string;
  limit?: number;
  used?: number;
  feature?: string;
  subscriptionStatus?: string;
  status: number;
}

/**
 * Turn one of the billing errors into the body an HTTP layer should
 * answer with, or null when `err` is something else entirely.
 *
 * Kept here — rather than in `toErrorResponse` — so the dashboard
 * routes and the public `/api/v1` envelope can share one source of
 * truth for the machine codes without importing each other.
 */
export function billingErrorPayload(err: unknown): BillingErrorPayload | null {
  if (err instanceof AccountLockedError) {
    return {
      error: err.message,
      code: err.code,
      upgradeUrl: BILLING_UPGRADE_PATH,
      subscriptionStatus: err.subscriptionStatus,
      status: err.status,
    };
  }
  if (err instanceof PlanLimitError) {
    return {
      error: err.message,
      code: err.code,
      upgradeUrl: BILLING_UPGRADE_PATH,
      metric: err.metric,
      limit: err.limit,
      used: err.used,
      status: err.status,
    };
  }
  if (err instanceof QuotaExceededError) {
    return {
      // The acceptance criterion of §4 in one sentence: which limit was
      // hit, and how to raise it.
      error: `You have used ${err.used} of your ${err.limit} '${err.metric}' allowance for this month. Upgrade the plan to raise this limit.`,
      code: 'quota_exceeded',
      upgradeUrl: BILLING_UPGRADE_PATH,
      metric: err.metric,
      limit: err.limit,
      used: err.used,
      status: 402,
    };
  }
  if (err instanceof FeatureNotAvailableError) {
    return {
      error: `'${err.feature}' is not included in your plan. Upgrade the plan to use it.`,
      code: 'feature_unavailable',
      upgradeUrl: BILLING_UPGRADE_PATH,
      feature: err.feature,
      status: 402,
    };
  }
  return null;
}

// ------------------------------------------------------------
// Asserts
// ------------------------------------------------------------

/**
 * §5: refuse a write while the account is read-only.
 *
 * `entitlements` is optional so a caller that already resolved them
 * (the routes that also check a quota) does not pay for a second
 * round trip.
 */
export async function assertWritable(
  accountId: string,
  entitlements?: Entitlements
): Promise<Entitlements> {
  const e = entitlements ?? (await getEntitlements(accountId));
  if (e.readOnly) throw new AccountLockedError(e.status);
  return e;
}

/**
 * Plan feature gate (`api`, `webhooks`, `ai_autoreply`, …). Throws
 * `FeatureNotAvailableError`, which `billingErrorPayload` renders as
 * a 402.
 */
export async function assertPlanFeature(
  accountId: string,
  feature: string,
  entitlements?: Entitlements
): Promise<Entitlements> {
  const e = entitlements ?? (await getEntitlements(accountId));
  if (!hasFeature(e, feature)) throw new FeatureNotAvailableError(feature);
  return e;
}

/**
 * Stock limit: `used + n` rows must fit inside the plan's cap.
 * `used` is counted live by the caller (it knows which table and which
 * filters make a "seat"). A `null` cap or an unknown metric never
 * throws, same convention as `assertQuota`.
 */
export function assertStockLimit(
  entitlements: Entitlements,
  metric: string,
  used: number,
  n = 1
): void {
  const limit = entitlements.limits[metric];
  if (limit === undefined || limit === null) return;
  if (used + n > limit) throw new PlanLimitError(metric, limit, used);
}

// ------------------------------------------------------------
// Counting
// ------------------------------------------------------------

/**
 * Increment a flow counter through the atomic RPC of migration 041.
 *
 * ALWAYS called after the action succeeded. Best-effort on purpose:
 * a counter that failed to move must never turn a message that Meta
 * already delivered into an error response for the operator. The miss
 * is logged so it can be reconciled; under-counting favours the
 * customer, which is the right way to be wrong about a bill.
 */
export async function recordUsage(
  accountId: string,
  metric: string,
  delta = 1
): Promise<void> {
  if (delta <= 0) return;
  try {
    const { error } = await supabaseAdmin().rpc('increment_usage', {
      p_account_id: accountId,
      p_metric: metric,
      p_delta: delta,
    });
    if (error) {
      console.error(
        `[billing] increment_usage(${metric}, ${delta}) failed for account ${accountId}:`,
        error
      );
    }
  } catch (err) {
    console.error(
      `[billing] increment_usage(${metric}, ${delta}) threw for account ${accountId}:`,
      err
    );
  }
}
