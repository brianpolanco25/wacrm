// ============================================================
// The subscription area of Fase 3 §6, as pure decisions.
//
// Everything in this module is I/O free so the two properties §6 is
// graded on can be tested directly:
//
//   1. "El consumo mostrado coincide con `usage_counters`." `buildUsage`
//      copies `value` across untouched. It does not scale it, cap it at
//      the limit, or turn a missing row into anything but a zero. The
//      only arithmetic is the bar width, and that is a separate field
//      the caller may ignore.
//
//   2. What a tenant may DO depends on the state PayPal left them in,
//      not on what the UI feels like offering. `availableActions` is
//      that table, in one place, because getting it wrong means either
//      a dead button or a second subscription charging the customer.
//
// Nothing here talks to PayPal and nothing here decides a status: the
// truth still arrives as a webhook event (§3).
// ============================================================

import type { BillingCycle } from './paypal';

// ------------------------------------------------------------
// Consumption
// ------------------------------------------------------------

/**
 * The metrics that accumulate in `usage_counters`, in display order.
 *
 * These are the three FLOW limits the enforcement layer of §4
 * increments with `increment_usage`. The stock limits (`operators`,
 * `numbers`, `knowledge_documents`) are a headcount of rows, never a
 * counter, so they have nothing in `usage_counters` to show — see the
 * header of `enforce.ts`. Showing them here with a zero would be a
 * lie, so they are absent.
 */
export const USAGE_METRICS = [
  'messages_out',
  'ai_replies',
  'broadcast_recipients',
] as const;

export interface UsageCounterRow {
  metric: string;
  value: number | string;
}

export interface UsageLine {
  metric: string;
  /** Straight from `usage_counters.value`. Never derived. */
  used: number;
  /** From `plans.limits`. `null` = unlimited, and then no bar. */
  limit: number | null;
  /** 0–100, for the bar only. `null` when there is no limit. */
  percent: number | null;
}

/**
 * Pair the account's counters for the current period with its plan's
 * limits.
 *
 * A metric with no counter row shows 0 (nothing used yet this month —
 * `increment_usage` only creates the row on first use). A counter for
 * a metric the plan does not cap still shows, with `limit: null`: the
 * number is real consumption and hiding it would make the panel
 * disagree with the bill.
 */
export function buildUsage(
  limits: Record<string, number | null>,
  counters: UsageCounterRow[]
): UsageLine[] {
  const used = new Map<string, number>();
  for (const row of counters) {
    if (typeof row?.metric !== 'string' || !row.metric) continue;
    // `value` is a bigint column; supabase-js hands it over as a
    // string on some drivers. Number() is a decode, not a transform —
    // anything that is not a finite number is dropped rather than
    // rendered as NaN.
    const n = Number(row.value);
    if (!Number.isFinite(n)) continue;
    used.set(row.metric, n);
  }

  const metrics: string[] = [...USAGE_METRICS];
  for (const metric of used.keys()) {
    if (!metrics.includes(metric)) metrics.push(metric);
  }

  return metrics.map((metric) => {
    const limit = limits[metric] ?? null;
    const value = used.get(metric) ?? 0;
    return {
      metric,
      used: value,
      limit,
      percent:
        limit === null || limit <= 0
          ? null
          : Math.min(100, Math.round((value / limit) * 100)),
    };
  });
}

// ------------------------------------------------------------
// Receipts
// ------------------------------------------------------------

export interface ReceiptRow {
  /** `billing_events.id` — stable key for the list. */
  id: string;
  /** PayPal's transaction id for the sale. */
  transactionId: string | null;
  /** Decimal string as PayPal sent it. Never re-rounded. */
  amount: string | null;
  currency: string | null;
  /** ISO timestamp of the payment. */
  paidAt: string | null;
  /** A customer-facing link, when the event carries one. */
  link: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A link a customer can actually open, or null.
 *
 * A sale resource's `links` are mostly API endpoints (`self`,
 * `refund`) that need an OAuth token and leak our API base — printing
 * one as "your receipt" would hand the customer a 401. Only an
 * explicitly customer-facing rel is taken, and only over https on
 * paypal.com, because this string comes from an external system and
 * ends up in an `href`.
 */
const CUSTOMER_LINK_RELS = new Set(['receipt', 'invoice']);

export function receiptLink(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  for (const raw of links) {
    const link = record(raw);
    if (!link) continue;
    const rel = str(link.rel)?.toLowerCase();
    const href = str(link.href);
    if (!rel || !href || !CUSTOMER_LINK_RELS.has(rel)) continue;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    if (url.hostname !== 'paypal.com' && !url.hostname.endsWith('.paypal.com'))
      continue;
    return url.toString();
  }
  return null;
}

/**
 * Turn one `PAYMENT.SALE.COMPLETED` row of `billing_events` into a
 * receipt line.
 *
 * The amount is kept as PayPal's own decimal string. Parsing money
 * into a float to print it again is how a receipt stops matching a
 * bank statement; the panel shows exactly what was charged.
 *
 * Returns null when the payload is not a sale we can describe — a row
 * with no amount is not a receipt, and an empty line in a list of
 * payments is worse than a shorter list.
 */
export function parseReceipt(row: {
  id: string;
  payload: unknown;
  received_at?: string | null;
}): ReceiptRow | null {
  const payload = record(row.payload);
  const resource = record(payload?.resource);
  if (!resource) return null;

  const amount = record(resource.amount);
  // v1 sales say `total`/`currency`; the v2-shaped payloads say
  // `value`/`currency_code`. Both appear in the wild depending on how
  // the plan was created, so both are read.
  const value = str(amount?.total) ?? str(amount?.value);
  const currency = str(amount?.currency) ?? str(amount?.currency_code);
  if (!value) return null;

  return {
    id: row.id,
    transactionId: str(resource.id),
    amount: value,
    currency,
    paidAt: str(resource.create_time) ?? row.received_at ?? null,
    link: receiptLink(resource.links),
  };
}

// ------------------------------------------------------------
// Actions
// ------------------------------------------------------------

export interface SubscriptionShape {
  status: string;
  cancelAtPeriodEnd: boolean;
  providerSubscriptionId: string | null;
}

/**
 * How to reactivate, or null when there is nothing to reactivate.
 *
 *   'activate'  PayPal suspended the subscription and can resume it
 *               (`POST /v1/billing/subscriptions/{id}/activate`).
 *   'checkout'  The subscription is gone for good — PayPal's cancel is
 *               irreversible — so the way back is the checkout of §2.
 */
export type ReactivateMode = 'activate' | 'checkout';

/**
 * How to change plan.
 *
 *   'revise'    There is a live PayPal subscription: move it onto the
 *               new plan. One subscription, one charge.
 *   'checkout'  Nothing is being charged (trial, cancelled, expired,
 *               or cancelled-at-period-end): contracting is the plan
 *               change, and it reuses §2 rather than duplicating it.
 */
export type ChangePlanMode = 'revise' | 'checkout';

export interface SubscriptionActions {
  cancel: boolean;
  reactivate: ReactivateMode | null;
  changePlan: ChangePlanMode;
}

/**
 * Statuses in which PayPal still holds this subscription object.
 *
 * `past_due` is ours, not PayPal's: a failed charge leaves the
 * subscription ACTIVE there until its retries run out. `suspended` is
 * PayPal's own pause — the object is alive and can be activated again.
 */
const CHARGING_STATUSES = new Set(['active', 'past_due', 'suspended']);

export function availableActions(
  subscription: SubscriptionShape | null
): SubscriptionActions {
  const providerId = subscription?.providerSubscriptionId ?? null;
  const status = subscription?.status ?? 'trialing';
  const cancelPending = Boolean(subscription?.cancelAtPeriodEnd);

  // PayPal still has a subscription we can act on. A cancellation it
  // already accepted is the end of the line — its cancel is immediate
  // and irreversible, whatever the local status says while the cycle
  // the customer paid for runs out.
  const alive =
    Boolean(providerId) && CHARGING_STATUSES.has(status) && !cancelPending;

  return {
    // Cancelling is valid for anything PayPal still holds, suspended
    // included: stopping the bill is a legitimate way out of a lock.
    cancel: alive,
    reactivate: alive
      ? status === 'suspended'
        ? 'activate'
        : null
      : cancelPending || status === 'cancelled' || status === 'expired'
        ? 'checkout'
        : null,
    changePlan: alive ? 'revise' : 'checkout',
  };
}

/**
 * The date the customer is next charged, or null.
 *
 * `cancel_at_period_end` means there is no next charge: the period end
 * is then the day service stops, and the panel labels it as such
 * instead of promising a renewal that will not happen.
 */
export function nextChargeAt(subscription: {
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
}): string | null {
  if (subscription.cancelAtPeriodEnd) return null;
  if (subscription.status === 'cancelled' || subscription.status === 'expired')
    return null;
  return subscription.currentPeriodEnd;
}

/** Narrow an unknown cycle to the two we sell. Null when unknown. */
export function asCycle(value: unknown): BillingCycle | null {
  return value === 'month' || value === 'year' ? value : null;
}
