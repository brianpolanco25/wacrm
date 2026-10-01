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
//   - An account with no `subscriptions` row resolves to `incomplete`
//     on plan `inicio`, read-only (s9.6, migration 073: there is no
//     free trial any more — the account has to give its company data
//     and pay before it may write). Before 073 the fallback was the
//     trial (`pro` / `trialing`); the migration moved every such row to
//     `incomplete`, so both paths now agree.
//   - `readOnly` is true when the subscription is `incomplete`,
//     `suspended` or `expired`, or when it is `past_due` and
//     `grace_until` has passed,
//     or when a platform operator put a MANUAL HOLD on the account
//     (migration 058). The hold is a separate axis from `status` on
//     purpose: `status` is what the PayPal webhook rewrites, so a hold
//     stored there would be lifted by the next payment event.
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

/**
 * `incomplete` (073): signed up, has not paid yet. `trialing` stays in
 * the union because the CHECK still accepts it and old rows or events
 * may carry it, but nothing writes it any more.
 */
export type SubscriptionStatus =
  | 'incomplete'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'cancelled'
  | 'expired';

/**
 * Plan an account falls back to when it has no `subscriptions` row —
 * the same one the 073 trigger seeds. With `incomplete` it grants
 * nothing (read-only); it is there because a plan has to be named.
 */
export const DEFAULT_PLAN_ID = 'inicio';

/** Status an account falls back to when it has no `subscriptions` row. */
export const DEFAULT_STATUS: SubscriptionStatus = 'incomplete';

export interface Entitlements {
  planId: string;
  status: SubscriptionStatus;
  /** Per-metric caps for the current period. `null` = unlimited. */
  limits: Record<string, number | null>;
  features: string[];
  /**
   * Solo lectura: la suscripción venció y pasó la gracia, O un operador
   * de la plataforma puso una retención manual.
   */
  readOnly: boolean;
  /**
   * Why, when `readOnly` is true. `null` when the account may write.
   *
   * Worth distinguishing because the two have different ways out: a
   * `subscription` lock is settled at `/billing` by the customer, and a
   * `manual_hold` is lifted only by the operator who put it there —
   * telling a manually suspended tenant to go and pay would send them
   * to a checkout that changes nothing.
   */
  readOnlyReason: 'subscription' | 'manual_hold' | 'statement' | null;
  /** A platform operator suspended this account by hand (058). */
  manualHold: boolean;
  /** ISO timestamp, or null when the account is not on a dated trial. */
  trialEndsAt: string | null;
  /**
   * Who pays Meta for this account's messages (076, fase 10): `direct`
   * (the customer, with their own card at Meta — every account before
   * fase 10) or `managed` (Cabbity pays Meta and bills the account at the
   * cut-off, s10.3/s10.4). The «add a payment method at Meta» notice is
   * for `direct` accounts only.
   */
  metaBilling: MetaBilling;
  /**
   * How a managed account pays (077): `paypal` (the fee through the
   * PayPal subscription) or `manual` (a statement confirmed by hand).
   * Null = whatever `provider` says — every row written before 077.
   */
  paymentMethod: PaymentMethod | null;
  /**
   * The oldest statement still `issued` of a managed account (078,
   * s10.4), or null. Past its `dueAt` the account is read-only
   * (`readOnlyReason = 'statement'`) whatever `status` says: the PayPal
   * webhook renews the FEE of a PayPal account and puts its row back to
   * `active`, and the overage still cuts off at three days (spec,
   * decision 2). Always null for `direct` accounts.
   */
  openStatement: OpenStatement | null;
}

export interface OpenStatement {
  id: string;
  periodStart: string;
  periodEnd: string;
  totalUsd: number;
  dueAt: string;
}

export type MetaBilling = 'direct' | 'managed';
export type PaymentMethod = 'paypal' | 'manual';

/** Narrow a stored `meta_billing`; anything unknown reads as `direct`. */
export function asMetaBilling(value: unknown): MetaBilling {
  return value === 'managed' ? 'managed' : 'direct';
}

/** Narrow a stored `payment_method`; anything unknown reads as null. */
export function asPaymentMethod(value: unknown): PaymentMethod | null {
  return value === 'paypal' || value === 'manual' ? value : null;
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
  'incomplete',
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
 * True when the account may only read: incomplete (never paid — s9.6),
 * suspended or expired outright, or past_due once the grace period has
 * run out. `cancelled` keeps access until the period ends (the gateway
 * then flips it to `expired`).
 */
export function isReadOnly(
  status: SubscriptionStatus,
  graceUntil: string | null,
  now: Date = new Date()
): boolean {
  if (status === 'incomplete' || status === 'suspended' || status === 'expired')
    return true;
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
  manual_hold_at: string | null;
  meta_billing?: string | null;
  payment_method?: string | null;
}

interface PlanRow {
  id: string;
  limits: unknown;
  features: string[] | null;
}

/**
 * Resolve the account's plan, status and derived flags. Falls back to
 * `inicio` / `incomplete` (read-only) when the account has no
 * subscription row.
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
    .select(
      'plan_id, status, trial_ends_at, grace_until, manual_hold_at, meta_billing, payment_method'
    )
    .eq('account_id', accountId)
    .maybeSingle();
  if (subErr) throw subErr;

  const subscription = (sub as SubscriptionRow | null) ?? null;
  const planId = subscription?.plan_id ?? DEFAULT_PLAN_ID;
  // An unknown status (a value a future migration adds before this
  // union learns it) fails closed, like a missing row: read-only.
  const status: SubscriptionStatus =
    subscription && isSubscriptionStatus(subscription.status)
      ? subscription.status
      : DEFAULT_STATUS;

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

  // The manual hold of migration 058. Read off the row we were already
  // fetching, so honouring it costs nothing on the write path.
  const manualHold = Boolean(subscription?.manual_hold_at);
  const subscriptionLock = isReadOnly(
    status,
    subscription?.grace_until ?? null
  );
  const metaBilling = asMetaBilling(subscription?.meta_billing);
  // s10.4: only a managed account has statements, so a direct one (every
  // account before fase 10) costs no extra query on the write path.
  const openStatement =
    metaBilling === 'managed' ? await loadOpenStatement(accountId) : null;
  const statementLock = isStatementOverdue(openStatement);

  return {
    planId,
    status,
    limits: normalizeLimits(planRow.limits),
    features: Array.isArray(planRow.features) ? planRow.features : [],
    readOnly: subscriptionLock || manualHold || statementLock,
    // The hold wins the label when both apply: it is the one the tenant
    // cannot resolve on their own, so it is the one they must be told
    // about. An overdue statement comes next: it says what to pay.
    readOnlyReason: manualHold
      ? 'manual_hold'
      : statementLock
        ? 'statement'
        : subscriptionLock
          ? 'subscription'
          : null,
    manualHold,
    trialEndsAt: subscription?.trial_ends_at ?? null,
    metaBilling,
    paymentMethod: asPaymentMethod(subscription?.payment_method),
    openStatement,
  };
}

/** True once an open statement is past its due date (s10.4). */
export function isStatementOverdue(
  statement: Pick<OpenStatement, 'dueAt'> | null,
  now: Date = new Date()
): boolean {
  if (!statement) return false;
  const due = Date.parse(statement.dueAt);
  return Number.isFinite(due) && due < now.getTime();
}

/**
 * The oldest `issued` statement of the account (078), or null.
 *
 * A failed read (the 078 not applied yet, a blip) is logged and read as
 * «none» rather than thrown: the status-based lock the cron already set
 * (`past_due` + `grace_until`) still applies, and failing every write of
 * a managed account over this extra check would be worse.
 */
async function loadOpenStatement(
  accountId: string
): Promise<OpenStatement | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('statements')
      .select('id, period_start, period_end, total_usd, due_at')
      .eq('account_id', accountId)
      .eq('status', 'issued')
      .order('due_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const row = data as {
      id?: unknown;
      period_start?: unknown;
      period_end?: unknown;
      total_usd?: unknown;
      due_at?: unknown;
    } | null;
    if (
      !row ||
      typeof row.id !== 'string' ||
      typeof row.due_at !== 'string' ||
      typeof row.period_start !== 'string' ||
      typeof row.period_end !== 'string'
    ) {
      return null;
    }
    const total = Number(row.total_usd);
    return {
      id: row.id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      totalUsd: Number.isFinite(total) ? total : 0,
      dueAt: row.due_at,
    };
  } catch (err) {
    console.error('[entitlements] open statement lookup failed:', err);
    return null;
  }
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
