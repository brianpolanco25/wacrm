// ============================================================
// PayPal webhook — what each event means for `subscriptions`
// (docs/saas/fase-3-facturacion.md §3).
//
// Everything here is pure: an event plus the rows we already have in,
// a decision out. The route does the I/O. That split exists because
// the interesting part of this feature is not the plumbing but the
// coherence rules, and those deserve tests that do not need a database
// or a PayPal sandbox.
//
// THE TWO RULES THAT SHAPE THIS FILE
// ----------------------------------
// 1. **Events arrive out of order.** PayPal makes no ordering promise
//    and retries on its own schedule, so an `ACTIVATED` can land after
//    the `CANCELLED` that followed it. Every decision is taken against
//    the row as it is now, never against an assumed sequence:
//    `subscriptions.last_event_at` (migration 050) is the watermark,
//    and an event older than it may only push `current_period_end`
//    forward. It can never change status, plan or grace.
//
// 2. **`current_period_end` only moves forward.** The failure we can
//    afford is a customer served a few days too long; the one we
//    cannot is a paying customer cut off because a replayed event
//    rewound their period.
// ============================================================

import type { BillingCycle } from './paypal';

/** The six events of the spec's table. Anything else is logged, not acted on. */
export const HANDLED_EVENT_TYPES = [
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

const HANDLED = new Set<string>(HANDLED_EVENT_TYPES);

export function isHandledEventType(
  eventType: string
): eventType is HandledEventType {
  return HANDLED.has(eventType);
}

/** Days of service after a failed payment before the account is suspended. */
export const GRACE_DAYS = 7;

// ------------------------------------------------------------
// Parsing
// ------------------------------------------------------------

export interface PayPalWebhookEvent {
  /** `event.id` — the idempotency key stored in `billing_events`. */
  id: string;
  eventType: string;
  /** ISO timestamp PayPal stamped on the event, or null if absent. */
  createTime: string | null;
  resource: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A number from a value PayPal may send either way.
 *
 * `quantity` is documented as a string and arrives as one today, but a
 * JSON number must not be dropped in silence: the whole point of
 * recording it is to make a discrepancy visible.
 */
function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = str(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read the envelope. Returns null when the body is not a PayPal event
 * we could ever act on — no id means no idempotency key, and without
 * one a retry would be processed twice.
 */
export function parseWebhookEvent(payload: unknown): PayPalWebhookEvent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const id = str(raw.id);
  const eventType = str(raw.event_type);
  if (!id || !eventType) return null;

  const resource =
    raw.resource &&
    typeof raw.resource === 'object' &&
    !Array.isArray(raw.resource)
      ? (raw.resource as Record<string, unknown>)
      : {};

  return {
    id,
    eventType,
    createTime: isoOrNull(raw.create_time),
    resource,
  };
}

function isoOrNull(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The PayPal subscription this event is about — our only link back to
 * a tenant.
 *
 * `BILLING.SUBSCRIPTION.*` carry it as the resource's own id.
 * `PAYMENT.SALE.COMPLETED` is a sale, not a subscription: the link is
 * `billing_agreement_id`, which for a subscription payment holds the
 * subscription id.
 */
export function subscriptionIdOf(event: PayPalWebhookEvent): string | null {
  if (event.eventType === 'PAYMENT.SALE.COMPLETED') {
    return str(event.resource.billing_agreement_id);
  }
  return str(event.resource.id);
}

/**
 * The `custom_id` we sent when creating the subscription — our own
 * account id, echoed back. Used only to *contradict* the account we
 * resolved from our own tables, never to pick one: a mismatch means
 * something is wrong enough that writing anywhere would be a guess.
 */
export function customIdOf(event: PayPalWebhookEvent): string | null {
  return str(event.resource.custom_id);
}

/** Provider plan id carried by a subscription resource, if any. */
export function providerPlanIdOf(event: PayPalWebhookEvent): string | null {
  return str(event.resource.plan_id);
}

/** `billing_info.next_billing_time`, normalised, or null. */
export function nextBillingTimeOf(event: PayPalWebhookEvent): string | null {
  const info = event.resource.billing_info;
  if (!info || typeof info !== 'object') return null;
  return isoOrNull((info as Record<string, unknown>).next_billing_time);
}

// ------------------------------------------------------------
// Dates
// ------------------------------------------------------------

/** The later of two ISO timestamps; nulls lose. */
export function laterIso(
  a: string | null | undefined,
  b: string | null | undefined
): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * One billing cycle after `iso`.
 *
 * Month arithmetic clamps instead of rolling over: a subscription
 * charged on the 31st renews on the 28th/30th, not on the 3rd of the
 * month after next, which is what a naive `setUTCMonth(+1)` gives.
 */
export function addCycle(iso: string, cycle: BillingCycle): string {
  const date = new Date(iso);
  const day = date.getUTCDate();
  const next = new Date(date.getTime());
  next.setUTCDate(1);
  if (cycle === 'year') {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  const daysInMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)
  ).getUTCDate();
  next.setUTCDate(Math.min(day, daysInMonth));
  return next.toISOString();
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}

// ------------------------------------------------------------
// Decision
// ------------------------------------------------------------

/** The `subscriptions` columns this module reads and writes. */
export interface SubscriptionState {
  plan_id: string;
  status: string;
  provider_subscription_id: string | null;
  current_period_end: string | null;
  grace_until: string | null;
  cancel_at_period_end: boolean;
  addons: Record<string, unknown> | null;
  last_event_at: string | null;
}

/** The `checkout_intents` columns this module reads. */
export interface IntentState {
  plan_id: string;
  cycle: BillingCycle;
  /**
   * The plan id AT PAYPAL the subscription was created with (migration
   * 048). The activation is contrasted against it: if PayPal says it
   * activated a different plan than the one the customer asked for, the
   * two records disagree about what was bought and neither may be
   * granted on a guess.
   */
  provider_plan_id?: string | null;
}

export interface SubscriptionPatch {
  plan_id?: string;
  status?: string;
  provider_subscription_id?: string;
  current_period_end?: string | null;
  grace_until?: string | null;
  cancel_at_period_end?: boolean;
  addons?: Record<string, unknown>;
  last_event_at?: string;
}

export type Decision =
  /** Nothing to write. Coherent, just not actionable. */
  | { kind: 'skip'; reason: string }
  /** We cannot tell what this event means. Recorded on the event row. */
  | { kind: 'error'; reason: string }
  | {
      kind: 'apply';
      patch: SubscriptionPatch;
      /** True when the event lost the race and only the period moved. */
      stale: boolean;
      /** Where the matching `checkout_intents` row should end up. */
      intentStatus: 'activated' | 'cancelled' | null;
    };

export interface DecisionInput {
  event: PayPalWebhookEvent;
  /** The account's current `subscriptions` row, or null if it has none. */
  existing: SubscriptionState | null;
  /** The `checkout_intents` row for this PayPal subscription, or null. */
  intent: IntentState | null;
  /**
   * Our plan id for the provider plan id the event carries, when the
   * catalogue knows it. Only `UPDATED` needs it — that is where PayPal
   * tells us the customer moved plan.
   */
  planFromProviderPlanId?: string | null;
  /** Clock, injected so the grace window is testable. */
  now: Date;
}

/**
 * PayPal subscription statuses, mapped onto ours. `APPROVAL_PENDING`
 * and `APPROVED` are checkout states and deliberately map to nothing:
 * the account has not paid yet, and writing anything for them would be
 * the "the return URL activates the plan" mistake by another route.
 */
const STATUS_MAP: Record<string, string> = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

/** Statuses a completed payment may lift back to `active`. */
const REVIVABLE = new Set(['trialing', 'active', 'past_due', 'suspended']);

/** Statuses that are the end of the line: a late event cannot undo them. */
const TERMINAL = new Set(['cancelled', 'expired']);

/**
 * The two events that mean "this was contracted and paid for". Only
 * these may take a terminal row over onto a new PayPal subscription —
 * see the re-contracting note in `decideSubscriptionChange`.
 */
const ADOPTING_EVENT_TYPES = new Set<string>([
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'PAYMENT.SALE.COMPLETED',
]);

export function decideSubscriptionChange(input: DecisionInput): Decision {
  const { event, existing, now } = input;
  const nowIso = now.toISOString();
  const eventTime = event.createTime ?? nowIso;

  if (!isHandledEventType(event.eventType)) {
    return { kind: 'skip', reason: `unhandled event type ${event.eventType}` };
  }

  const subscriptionId = subscriptionIdOf(event);
  if (!subscriptionId) {
    return { kind: 'error', reason: 'event carries no subscription id' };
  }

  // A different PayPal subscription than the one this account is on.
  // Resolving the account by subscription id makes this rare, but a
  // tenant with a second subscription (a failed plan change, a manual
  // one created in the PayPal dashboard) must not have their live row
  // rewritten by the other one's events.
  const onAnotherSubscription = Boolean(
    existing?.provider_subscription_id &&
    existing.provider_subscription_id !== subscriptionId
  );

  // The exception is re-contracting after a cancellation. §2 lets an
  // account whose subscription is `cancelled` or `expired` buy again
  // (CONTRACTED_STATUSES in checkout.ts) and nothing ever clears the
  // old provider id, so the row still points at the subscription that
  // died. Refusing the activation of the NEW one would mean the
  // customer pays and never gets service — the exact damage §3 exists
  // to prevent. Adoption is therefore allowed, but narrowly: only for
  // the two events that mean "contracted and paid", only over a row
  // whose subscription is terminal, and only when the checkout intent
  // for THIS subscription is one of ours — that intent is what
  // identified the account in the first place. A live row on another
  // subscription is still refused.
  const adopting =
    onAnotherSubscription &&
    ADOPTING_EVENT_TYPES.has(event.eventType) &&
    TERMINAL.has(existing!.status) &&
    Boolean(input.intent);

  if (onAnotherSubscription && !adopting) {
    return {
      kind: 'error',
      reason: `event is for subscription ${subscriptionId} but the account is on ${existing!.provider_subscription_id}`,
    };
  }

  const built = buildPatch({
    ...input,
    subscriptionId,
    eventTime,
    nowIso,
    adopting,
  });
  if (built.kind !== 'apply') return built;

  // End of the line for the subscription the row is on: once it is
  // `cancelled` or `expired`, nothing from that same subscription lifts
  // it back — not even an event newer than the watermark. Symmetric
  // with the TERMINAL guards of SUSPENDED and PAYMENT.FAILED, and,
  // unlike them, independent of `last_event_at`, which is NULL on every
  // row that predates migration 050. Treated as a late delivery rather
  // than a flat refusal so the period end may still move forward:
  // whoever paid keeps what they paid for.
  const terminated =
    !adopting &&
    existing !== null &&
    existing.provider_subscription_id === subscriptionId &&
    TERMINAL.has(existing.status);

  // Out of order: an event stamped before the last one we applied may
  // only push the period end forward. Status, plan, grace and the
  // cancellation flag all belong to whatever we already applied.
  const late = Boolean(
    existing?.last_event_at &&
    Date.parse(eventTime) < Date.parse(existing.last_event_at)
  );

  // Adoption is never late: the watermark belongs to the subscription
  // that died, not to the one being contracted now.
  const stale = !adopting && (terminated || late);

  let patch = built.patch;
  if (stale) {
    patch = {};
    if (built.patch.current_period_end) {
      patch.current_period_end = built.patch.current_period_end;
    }
  }

  // Never rewind the period, whatever the event says.
  if (patch.current_period_end !== undefined) {
    const forward = laterIso(
      existing?.current_period_end,
      patch.current_period_end
    );
    if (forward === existing?.current_period_end) {
      delete patch.current_period_end;
    } else {
      patch.current_period_end = forward;
    }
  }

  if (Object.keys(patch).length === 0) {
    return {
      kind: 'skip',
      reason: terminated
        ? `subscription is already ${existing!.status}`
        : stale
          ? 'event is older than the last one applied and moves nothing forward'
          : 'event changes nothing',
    };
  }

  if (!stale) patch.last_event_at = eventTime;

  return {
    kind: 'apply',
    patch,
    stale,
    intentStatus: stale ? null : built.intentStatus,
  };
}

interface BuildInput extends DecisionInput {
  subscriptionId: string;
  eventTime: string;
  nowIso: string;
  /**
   * True when this event takes a terminal row over onto its own, newer
   * PayPal subscription (re-contracting after a cancellation).
   */
  adopting: boolean;
}

function buildPatch(input: BuildInput): Decision {
  const {
    event,
    existing,
    intent,
    subscriptionId,
    eventTime,
    nowIso,
    adopting,
  } = input;

  switch (event.eventType as HandledEventType) {
    // ------------------------------------------------------------
    // The customer approved and PayPal took the money.
    // ------------------------------------------------------------
    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      const planId = intent?.plan_id ?? existing?.plan_id;
      if (!planId) {
        return {
          kind: 'error',
          reason: `no checkout intent for subscription ${subscriptionId}; cannot tell which plan was bought`,
        };
      }

      // What PayPal says was activated against what the customer asked
      // for. Migration 048 keeps `provider_plan_id` on the intent for
      // exactly this: if the two disagree, the approved subscription is
      // not the one we created, and granting either plan would be a
      // guess. It goes to the reconciliation queue with its payload
      // instead.
      const activatedPlan = providerPlanIdOf(event);
      if (
        activatedPlan &&
        intent?.provider_plan_id &&
        activatedPlan !== intent.provider_plan_id
      ) {
        return {
          kind: 'error',
          reason: `PayPal activated plan ${activatedPlan} for subscription ${subscriptionId} but the checkout intent asked for ${intent.provider_plan_id}`,
        };
      }

      const cycleEnd =
        nextBillingTimeOf(event) ??
        (intent ? addCycle(eventTime, intent.cycle) : null);

      return {
        kind: 'apply',
        stale: false,
        intentStatus: 'activated',
        patch: {
          plan_id: planId,
          status: 'active',
          provider_subscription_id: subscriptionId,
          current_period_end: cycleEnd,
          // A fresh activation clears whatever the previous cycle left
          // behind: a subscription cannot be active and in its grace
          // window, nor active and already scheduled to stop.
          grace_until: null,
          cancel_at_period_end: false,
        },
      };
    }

    // ------------------------------------------------------------
    // PayPal changed something on the subscription: plan or quantity.
    // ------------------------------------------------------------
    case 'BILLING.SUBSCRIPTION.UPDATED': {
      if (!existing) {
        return {
          kind: 'skip',
          reason: `update for subscription ${subscriptionId}, which this account has never had activated`,
        };
      }
      const patch: SubscriptionPatch = {};

      const resolvedPlan = input.planFromProviderPlanId ?? null;
      const providerPlanId = providerPlanIdOf(event);
      if (providerPlanId && !resolvedPlan) {
        // The customer is on a PayPal plan our catalogue does not know
        // — a plan created by hand, or a price revision whose ids were
        // never stored. Guessing would bill the wrong tier.
        return {
          kind: 'error',
          reason: `PayPal plan ${providerPlanId} is not in our catalogue`,
        };
      }
      if (resolvedPlan && resolvedPlan !== existing.plan_id) {
        patch.plan_id = resolvedPlan;
      }

      const nextBilling = nextBillingTimeOf(event);
      if (nextBilling) patch.current_period_end = nextBilling;

      // "Reconciliar plan y cantidad": we sell fixed tiers, so quantity
      // is always 1 and has nowhere of its own to live. Recording it in
      // `addons` keeps it visible if PayPal ever reports something else
      // instead of silently dropping a discrepancy.
      const quantity = numberOrNull(event.resource.quantity);
      if (quantity !== null && quantity > 0) {
        const current = existing.addons ?? {};
        if (current.paypal_quantity !== quantity) {
          patch.addons = { ...current, paypal_quantity: quantity };
        }
      }

      const mapped = STATUS_MAP[str(event.resource.status) ?? ''];
      if (mapped && mapped !== existing.status) patch.status = mapped;

      return { kind: 'apply', stale: false, intentStatus: null, patch };
    }

    // ------------------------------------------------------------
    // Cancelled: service runs to the end of the paid cycle. PayPal has
    // no proration and we do not emulate one — the customer keeps what
    // they paid for.
    // ------------------------------------------------------------
    case 'BILLING.SUBSCRIPTION.CANCELLED': {
      if (!existing) {
        return {
          kind: 'skip',
          reason: `cancellation for subscription ${subscriptionId}, which this account never had activated`,
        };
      }
      const paidThrough =
        existing.current_period_end &&
        Date.parse(existing.current_period_end) > Date.parse(nowIso);

      return {
        kind: 'apply',
        stale: false,
        intentStatus: 'cancelled',
        patch: paidThrough
          ? { cancel_at_period_end: true }
          : // Nothing left to serve: no future period end, so the flag
            // would be a promise with no date behind it.
            { cancel_at_period_end: true, status: 'cancelled' },
      };
    }

    // ------------------------------------------------------------
    case 'BILLING.SUBSCRIPTION.SUSPENDED': {
      if (!existing) {
        return {
          kind: 'skip',
          reason: `suspension for subscription ${subscriptionId}, which this account never had activated`,
        };
      }
      if (TERMINAL.has(existing.status)) {
        return {
          kind: 'skip',
          reason: `subscription is already ${existing.status}`,
        };
      }
      return {
        kind: 'apply',
        stale: false,
        intentStatus: null,
        patch: { status: 'suspended' },
      };
    }

    // ------------------------------------------------------------
    // Payment failed: seven days of grace before the ladder of
    // docs/saas/fase-3-facturacion.md §5 takes the account to
    // `suspended`. Inbound messages keep arriving throughout (CP11).
    // ------------------------------------------------------------
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
      if (!existing) {
        return {
          kind: 'skip',
          reason: `payment failure for subscription ${subscriptionId}, which this account never had activated`,
        };
      }
      if (TERMINAL.has(existing.status)) {
        return {
          kind: 'skip',
          reason: `subscription is already ${existing.status}`,
        };
      }
      return {
        kind: 'apply',
        stale: false,
        intentStatus: null,
        patch: {
          status: 'past_due',
          // From the event, not from `now`: a delivery retried two days
          // later must not hand out two extra days of grace.
          grace_until: addDays(eventTime, GRACE_DAYS),
        },
      };
    }

    // ------------------------------------------------------------
    // Money arrived. This fires for the first payment too, right next
    // to ACTIVATED — hence the `laterIso` in the caller: one cycle from
    // the sale is roughly the activation's own `next_billing_time`, so
    // taking the later of the two neither double-extends the first
    // cycle nor misses a renewal.
    // ------------------------------------------------------------
    case 'PAYMENT.SALE.COMPLETED': {
      const cycle = intent?.cycle;
      const planId = intent?.plan_id ?? existing?.plan_id;
      if (!planId || !cycle) {
        return {
          kind: 'error',
          reason: `no checkout intent for subscription ${subscriptionId}; cannot tell which plan or cycle was paid`,
        };
      }

      const periodEnd = addCycle(eventTime, cycle);

      if (!existing || adopting) {
        // The sale beat the activation. Creating the row — or taking
        // over the terminal one left by the subscription this customer
        // cancelled — keeps them served; ACTIVATED arrives later and
        // only reconciles the period end. The alternative — ignoring a
        // payment we have taken — is the "impossible state" the spec
        // warns about.
        return {
          kind: 'apply',
          stale: false,
          intentStatus: 'activated',
          patch: {
            plan_id: planId,
            status: 'active',
            provider_subscription_id: subscriptionId,
            current_period_end: periodEnd,
            grace_until: null,
            cancel_at_period_end: false,
          },
        };
      }

      const patch: SubscriptionPatch = { current_period_end: periodEnd };
      if (REVIVABLE.has(existing.status)) {
        if (existing.status !== 'active') patch.status = 'active';
        if (existing.grace_until !== null) patch.grace_until = null;
      }
      // A payment on a cancelled or expired subscription is not a
      // reason to resurrect it; the period still moves forward so the
      // customer keeps what they paid for.
      return { kind: 'apply', stale: false, intentStatus: null, patch };
    }
  }
}
