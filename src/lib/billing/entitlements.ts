// ============================================================
// Entitlements — what a tenant is allowed to do, derived from its
// subscription + plan (migration 041_billing_model.sql).
//
// Fase 0 del programa SaaS: this module is CREATED AND TESTED but NOT
// CALLED from any route yet. Wiring it into routes (and mapping the
// typed errors below to HTTP responses) is fase 3. Keeping the two
// steps apart lets the model be reviewed without risking a regression
// in production.
//
// Rules
//   - An account with no `subscriptions` row resolves to the trial:
//     plan `pro`, status `trialing`, not read-only. The 14-day trial
//     uses Pro's limits; its end date is stamped by fase 3 when it
//     seeds subscriptions, so `trialEndsAt` is null here.
//   - `readOnly` is true when the subscription is `suspended` or
//     `expired`, or when it is `past_due` and `grace_until` has passed.
//   - Quotas are checked against `usage_counters` for the CURRENT
//     calendar month (same anchor as `increment_usage`, which uses
//     `date_trunc('month', now())`). A `null` limit means unlimited; an
//     unknown metric is never limited.
//
// Isolation: every query here runs under the service-role client
// (`supabaseAdmin()`), which bypasses RLS, so every query filters by
// `account_id` by hand. Never drop that filter.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client';

export type SubscriptionStatus =
  'trialing' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'expired';

/** Plan an account falls back to when it has no `subscriptions` row. */
export const TRIAL_PLAN_ID = 'pro';

export interface Entitlements {
  planId: string;
  status: SubscriptionStatus;
  /** Per-metric caps for the current period. `null` = unlimited. */
  limits: Record<string, number | null>;
  features: string[];
  /** Solo lectura: la suscripción venció y pasó la gracia. */
  readOnly: boolean;
  /** ISO timestamp, or null when the account is not on a dated trial. */
  trialEndsAt: string | null;
}

// ------------------------------------------------------------
// Typed errors — fase 3 maps these to HTTP responses.
// ------------------------------------------------------------

export class QuotaExceededError extends Error {
  readonly metric: string;
  readonly limit: number;
  readonly used: number;
  constructor(metric: string, limit: number, used: number) {
    super(`Quota exceeded for '${metric}': ${used}/${limit} used this period`);
    this.name = 'QuotaExceededError';
    this.metric = metric;
    this.limit = limit;
    this.used = used;
  }
}

export class FeatureNotAvailableError extends Error {
  readonly feature: string;
  constructor(feature: string) {
    super(`Feature '${feature}' is not available on the current plan`);
    this.name = 'FeatureNotAvailableError';
    this.feature = feature;
  }
}

// ------------------------------------------------------------
// Pure helpers (no I/O) — exported so they can be unit-tested directly.
// ------------------------------------------------------------

const STATUSES: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'suspended',
  'cancelled',
  'expired',
];

function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
  );
}

/**
 * True when the account may only read: suspended/expired outright, or
 * past_due once the grace period has run out. `cancelled` keeps access
 * until the period ends (the gateway then flips it to `expired`).
 */
export function isReadOnly(
  status: SubscriptionStatus,
  graceUntil: string | null,
  now: Date = new Date()
): boolean {
  if (status === 'suspended' || status === 'expired') return true;
  if (status === 'past_due' && graceUntil) {
    const grace = new Date(graceUntil);
    return Number.isFinite(grace.getTime()) && grace.getTime() < now.getTime();
  }
  return false;
}

/**
 * First day of the current calendar month as `YYYY-MM-01` (UTC), matching
 * `increment_usage`'s `date_trunc('month', now())::date` under Supabase's
 * UTC session timezone.
 */
export function currentPeriodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Normalise a `plans.limits` jsonb blob into `Record<string, number|null>`.
 * Anything that is neither a finite number nor null is dropped rather than
 * silently treated as a cap.
 */
export function normalizeLimits(raw: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) out[key] = null;
    else if (typeof value === 'number' && Number.isFinite(value))
      out[key] = value;
  }
  return out;
}

export function hasFeature(e: Entitlements, feature: string): boolean {
  return e.features.includes(feature);
}

/** `hasFeature` that throws the typed error instead of returning false. */
export function assertFeature(e: Entitlements, feature: string): void {
  if (!hasFeature(e, feature)) throw new FeatureNotAvailableError(feature);
}

// ------------------------------------------------------------
// Data access
// ------------------------------------------------------------

interface SubscriptionRow {
  plan_id: string;
  status: string;
  trial_ends_at: string | null;
  grace_until: string | null;
}

interface PlanRow {
  id: string;
  limits: unknown;
  features: string[] | null;
}

/**
 * Resolve the account's plan, status and derived flags. Falls back to
 * the trial plan when the account has no subscription row.
 *
 * Throws on a DB error or when the resolved plan is missing from the
 * catalogue — both are deployment faults (041 not applied, plan deleted),
 * not tenant states, and must surface rather than degrade to "no
 * limits".
 */
export async function getEntitlements(
  accountId: string
): Promise<Entitlements> {
  const db = supabaseAdmin();

  const { data: sub, error: subErr } = await db
    .from('subscriptions')
    .select('plan_id, status, trial_ends_at, grace_until')
    .eq('account_id', accountId)
    .maybeSingle();
  if (subErr) throw subErr;

  const subscription = (sub as SubscriptionRow | null) ?? null;
  const planId = subscription?.plan_id ?? TRIAL_PLAN_ID;
  const status: SubscriptionStatus =
    subscription && isSubscriptionStatus(subscription.status)
      ? subscription.status
      : 'trialing';

  const { data: plan, error: planErr } = await db
    .from('plans')
    .select('id, limits, features')
    .eq('id', planId)
    .maybeSingle();
  if (planErr) throw planErr;
  if (!plan) {
    throw new Error(
      `[entitlements] plan '${planId}' is missing from the plans catalogue (account ${accountId})`
    );
  }
  const planRow = plan as PlanRow;

  return {
    planId,
    status,
    limits: normalizeLimits(planRow.limits),
    features: Array.isArray(planRow.features) ? planRow.features : [],
    readOnly: isReadOnly(status, subscription?.grace_until ?? null),
    trialEndsAt: subscription?.trial_ends_at ?? null,
  };
}

/**
 * Throw `QuotaExceededError` if consuming `n` more units of `metric` this
 * calendar month would exceed the plan's limit. A `null` limit and an
 * unknown metric never throw.
 *
 * This is a pre-check only; the authoritative increment is the
 * `increment_usage` RPC. Fase 3 decides whether to call this before the
 * RPC or to compare the RPC's returned value against the limit.
 */
export async function assertQuota(
  accountId: string,
  metric: string,
  n = 1
): Promise<void> {
  const entitlements = await getEntitlements(accountId);
  const limit = entitlements.limits[metric];
  if (limit === undefined || limit === null) return;

  const { data, error } = await supabaseAdmin()
    .from('usage_counters')
    .select('value')
    .eq('account_id', accountId)
    .eq('metric', metric)
    .eq('period_start', currentPeriodStart())
    .maybeSingle();
  if (error) throw error;

  const used = Number((data as { value?: unknown } | null)?.value ?? 0);
  if (used + n > limit) throw new QuotaExceededError(metric, limit, used);
}
