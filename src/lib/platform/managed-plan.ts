// ============================================================
// The managed plan from the platform panel (fase 10, s10.3).
//
// `gestionado` is a hidden plan (077) given by hand: Cabbity pays Meta
// for the account's messages and bills it at the monthly cut-off — a
// fixed fee with a package of delivered messages, then an overage per
// Meta category (`subscriptions.meta_pricing`, 076). Two ways to pay:
//
//   manual  `overridePlan` with terms (provisioning.ts): active at once,
//           monthly, the first cut-off one month from now.
//   paypal  `assignManagedPlanViaPayPal` below: the fee goes through a
//           PayPal subscription. The plan is published to PayPal if it
//           is not yet (the s9.3 sync, explicitly allowing a hidden
//           plan), a subscription is created FOR THIS ACCOUNT with the
//           same call, idempotency key and `checkout_intents` row as the
//           tenant's own checkout, and the account stays `incomplete`
//           (read-only, s9.6) until PayPal's webhook activates it. The
//           approval link goes back to the operator, who sends it to the
//           owner: there is no mail provider.
//
// And later, `updateManagedPricing`: the price and the payment method of
// an account already on managed billing. A change applies from the next
// statement on; statements already issued (s10.4) never move.
//
// Same rules as `provisioning.ts`: SERVICE ROLE, every query on tenant
// data filtered by the account of the file, the bitácora written BEFORE
// the tenant's rows change. `plans` / `plan_provider_history` are the
// global catalogue, keyed by plan id.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';
import {
  CHECKOUT_BRAND_NAME,
  checkoutRequestId,
  checkoutUrls,
} from '@/lib/billing/checkout';
import {
  asMetaBilling,
  asPaymentMethod,
  type MetaBilling,
  type PaymentMethod,
} from '@/lib/billing/entitlements';
import type { MetaPricing } from '@/lib/billing/meta-pricing';
import {
  createSubscription,
  getSubscription,
  PayPalError,
} from '@/lib/billing/paypal';
import { syncPlanCycle } from '@/lib/billing/plan-sync';
import { recordPlatformAction } from './audit';
import {
  isLivePayPalSubscription,
  loadAssignablePlan,
  loadCurrentSubscription,
  planPricingOf,
} from './provisioning';

export type ManagedPayPalOutcome =
  | {
      ok: true;
      approvalUrl: string;
      subscriptionId: string;
      providerPlanId: string;
      /** True when the plan had to be created at PayPal first. */
      published: boolean;
      /**
       * True when the account already had a checkout waiting for the
       * owner and THAT one is handed out again (no second subscription).
       */
      reused: boolean;
      fromPlan: string | null;
      fromProvider: string | null;
    }
  | {
      ok: false;
      reason:
        | 'unknown_plan'
        | 'paypal_active'
        | 'audit_failed'
        | 'not_managed_plan'
        | 'checkout_in_progress';
    };

/** A checkout of this account still waiting for the webhook (048). */
interface PendingAttempt {
  id: string;
  provider_plan_id: string | null;
  provider_subscription_id: string;
}

/**
 * The latest `pending` PayPal attempt of THIS account for this plan, or
 * null. Scoped by account: it is what decides whether a repeated
 * assignment opens a second subscription.
 */
async function findPendingAttempt(
  accountId: string,
  planId: string
): Promise<PendingAttempt | null> {
  const { data, error } = await supabaseAdmin()
    .from('checkout_intents')
    .select('id, provider_plan_id, provider_subscription_id, created_at')
    .eq('account_id', accountId)
    .eq('provider', 'paypal')
    .eq('plan_id', planId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.error('[platform/managed-plan] pending intent read failed:', error);
    throw error;
  }
  const row = ((data as PendingAttempt[] | null) ?? [])[0];
  return row?.provider_subscription_id ? row : null;
}

/** PayPal statuses of a subscription the buyer has already approved. */
const IN_FLIGHT = new Set(['APPROVED', 'ACTIVE']);

export interface GetSubscriptionFn {
  (subscriptionId: string): ReturnType<typeof getSubscription>;
}

export interface CreateSubscriptionFn {
  (
    args: Parameters<typeof createSubscription>[0]
  ): ReturnType<typeof createSubscription>;
}

/**
 * Put one company on a plan with a Meta price policy, paid through
 * PayPal. Order: checks → PayPal (publish the plan if needed, create the
 * subscription) → bitácora → `checkout_intents` → `subscriptions`.
 *
 * PayPal goes first because nothing there touches the tenant: a pending
 * subscription nobody approves expires on its own, exactly like the
 * checkout's fail-closed path. The trail is written before any row of
 * the account changes, and it carries the PayPal subscription id.
 *
 * Throws `PlanSyncError` (publishing) and `PayPalError` (subscription);
 * the route maps them.
 */
export async function assignManagedPlanViaPayPal(params: {
  accountId: string;
  accountName: string | null;
  planId: string;
  actorUserId: string;
  reason: string;
  metaBilling: MetaBilling;
  /**
   * The price of the account. Null = the plan's default
   * (`plans.meta_pricing`); ignored for `direct`.
   */
  metaPricing: MetaPricing | null;
  /** Origin PayPal sends the owner back to (`resolveAppOrigin`). */
  origin: string;
  createSubscriptionFn?: CreateSubscriptionFn;
  getSubscriptionFn?: GetSubscriptionFn;
}): Promise<ManagedPayPalOutcome> {
  const plan = await loadAssignablePlan(params.planId);
  if (!plan) return { ok: false, reason: 'unknown_plan' };
  // PayPal as a payment method belongs to the managed plan: any other
  // plan is sold by the tenant's own checkout.
  const planPricing = planPricingOf(plan.meta_pricing);
  if (!planPricing) return { ok: false, reason: 'not_managed_plan' };
  const managed = params.metaBilling === 'managed';
  const pricing = params.metaPricing ?? planPricing;

  const current = await loadCurrentSubscription(params.accountId);
  if (isLivePayPalSubscription(current)) {
    return { ok: false, reason: 'paypal_active' };
  }

  // 0. A checkout already waiting for the owner? The account stays
  //    `incomplete` with no gateway id until the webhook, so the live
  //    PayPal guard above cannot see it, and PayPal only replays the
  //    same subscription for the same PayPal-Request-Id within the
  //    ten-minute bucket. Ask PayPal about the pending attempt instead:
  //      APPROVAL_PENDING      → hand out the same link, create nothing;
  //      APPROVED / ACTIVE     → the owner already paid, the webhook is
  //                              on its way: 409, create nothing;
  //      anything else / 404   → that link is dead: close the attempt
  //                              and open a new one.
  const db = supabaseAdmin();
  const pending = await findPendingAttempt(params.accountId, plan.id);
  let reused: {
    id: string;
    approvalUrl: string;
    providerPlanId: string | null;
  } | null = null;
  if (pending) {
    const read = params.getSubscriptionFn ?? getSubscription;
    let remote: Awaited<ReturnType<typeof getSubscription>> | null = null;
    try {
      remote = await read(pending.provider_subscription_id);
    } catch (err) {
      if (!(err instanceof PayPalError && err.status === 404)) throw err;
    }
    if (remote?.status === 'APPROVAL_PENDING' && remote.approvalUrl) {
      reused = {
        id: pending.provider_subscription_id,
        approvalUrl: remote.approvalUrl,
        providerPlanId: pending.provider_plan_id,
      };
    } else if (remote && IN_FLIGHT.has(remote.status)) {
      return { ok: false, reason: 'checkout_in_progress' };
    } else {
      const { error: closeError } = await db
        .from('checkout_intents')
        .update({ status: 'cancelled' })
        .eq('account_id', params.accountId)
        .eq('id', pending.id);
      if (closeError) {
        console.error(
          '[platform/managed-plan] stale intent close failed:',
          closeError
        );
        throw closeError;
      }
    }
  }

  // 1. The plan at PayPal: the s9.3 sync, which records it in the
  //    history like a publication from /platform/plans. Only when it is
  //    missing — an existing id is used as it is.
  let providerPlanId =
    reused?.providerPlanId ?? (plan.provider_plan_id_month?.trim() || null);
  let published = false;
  if (!providerPlanId) {
    const synced = await syncPlanCycle({
      planId: plan.id,
      cycle: 'month',
      actorUserId: params.actorUserId,
      allowHidden: true,
    });
    providerPlanId = synced.providerPlanId;
    published = synced.action !== 'noop';
  }

  // 2. The subscription, created for THIS account: same call, same
  //    `custom_id` and idempotency key as `POST /api/billing/checkout`.
  //    The account is `incomplete`, so PayPal sends the owner back to
  //    the onboarding's waiting page. A reused attempt keeps its own.
  let subscription: { id: string; approvalUrl: string };
  if (reused) {
    subscription = { id: reused.id, approvalUrl: reused.approvalUrl };
  } else {
    const { returnUrl, cancelUrl } = checkoutUrls(params.origin, {
      onboarding: true,
    });
    const create = params.createSubscriptionFn ?? createSubscription;
    subscription = await create({
      planId: providerPlanId,
      customId: params.accountId,
      returnUrl,
      cancelUrl,
      brandName: CHECKOUT_BRAND_NAME,
      requestId: checkoutRequestId(params.accountId, plan.id, 'month'),
    });
  }

  const fromPlan = current?.plan_id ?? null;
  const fromProvider = current?.provider ?? null;
  const metaPricing = managed ? pricing : {};

  // 3. The trail, before the account changes.
  const logged = await recordPlatformAction({
    action: 'plan_override',
    actorUserId: params.actorUserId,
    accountId: params.accountId,
    accountName: params.accountName,
    reason: params.reason,
    details: {
      from_plan: fromPlan,
      to_plan: plan.id,
      from_provider: fromProvider,
      payment_method: 'paypal',
      meta_billing: managed ? 'managed' : 'direct',
      meta_pricing: metaPricing,
      from_meta_billing: current?.meta_billing ?? null,
      provider_plan_id: providerPlanId,
      provider_subscription_id: subscription.id,
      paypal_plan_published: published,
      reused_pending_checkout: Boolean(reused),
    },
  });
  if (!logged) return { ok: false, reason: 'audit_failed' };

  // 4. The attempt, so the webhook can tell which account and plan this
  //    PayPal subscription is (048). Scoped by the account of the file.
  //    A reused attempt already has its row.
  const { error: intentError } = reused
    ? { error: null }
    : await db.from('checkout_intents').insert({
        account_id: params.accountId,
        plan_id: plan.id,
        cycle: 'month',
        provider: 'paypal',
        provider_plan_id: providerPlanId,
        provider_subscription_id: subscription.id,
        created_by: params.actorUserId,
        status: 'pending',
      });
  // 23505: PayPal replayed the same request id (a second click within
  // the ten-minute bucket) and the intent is already there.
  if (intentError && intentError.code !== '23505') {
    console.error('[platform/managed-plan] intent insert failed:', intentError);
    throw intentError;
  }

  // 5. The account: unpaid until PayPal says otherwise. No gateway id
  //    yet — the webhook finds the account through the intent and writes
  //    it on activation, with `status = 'active'` and the period end.
  const { error } = await db.from('subscriptions').upsert(
    {
      account_id: params.accountId,
      plan_id: plan.id,
      provider: 'paypal',
      status: 'incomplete',
      provider_subscription_id: null,
      cycle: 'month',
      trial_ends_at: null,
      grace_until: null,
      current_period_end: null,
      cancel_at_period_end: false,
      payment_method: 'paypal',
      meta_billing: managed ? 'managed' : 'direct',
      meta_pricing: metaPricing,
    },
    { onConflict: 'account_id' }
  );
  if (error) {
    console.error('[platform/managed-plan] subscription write failed:', error);
    throw error;
  }

  return {
    ok: true,
    approvalUrl: subscription.approvalUrl,
    subscriptionId: subscription.id,
    providerPlanId,
    published,
    reused: Boolean(reused),
    fromPlan,
    fromProvider,
  };
}

// ------------------------------------------------------------
// Later: the price and the payment method of a managed account
// ------------------------------------------------------------

export type ManagedPricingOutcome =
  | {
      ok: true;
      changed: boolean;
      metaPricing: MetaPricing | Record<string, never>;
      paymentMethod: PaymentMethod | null;
    }
  | {
      ok: false;
      reason:
        'not_managed' | 'paypal_active' | 'needs_checkout' | 'audit_failed';
    };

function samePricing(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/**
 * Change `meta_pricing` and/or `payment_method` of ONE account that is
 * already on managed Meta billing. Bitácora first (`plan_override`, with
 * before/after in `details`), then the row.
 *
 * The payment method only moves where the gateway already agrees, so the
 * statements of s10.4 never charge the fee twice or not at all:
 *   - to `manual` while PayPal is still billing the fee → `paypal_active`
 *     (cancel it at PayPal first);
 *   - to `paypal` without a live PayPal subscription → `needs_checkout`
 *     (assign the plan with PayPal from the file: that creates it).
 */
export async function updateManagedPricing(params: {
  accountId: string;
  accountName: string | null;
  actorUserId: string;
  reason: string;
  metaPricing?: MetaPricing;
  paymentMethod?: PaymentMethod;
}): Promise<ManagedPricingOutcome> {
  const current = await loadCurrentSubscription(params.accountId);
  if (!current || asMetaBilling(current.meta_billing) !== 'managed') {
    return { ok: false, reason: 'not_managed' };
  }

  const live = isLivePayPalSubscription(current);
  const beforeMethod = asPaymentMethod(current.payment_method);
  const nextMethod = params.paymentMethod ?? beforeMethod;
  if (params.paymentMethod && params.paymentMethod !== beforeMethod) {
    if (params.paymentMethod === 'manual' && live) {
      return { ok: false, reason: 'paypal_active' };
    }
    if (params.paymentMethod === 'paypal' && !live) {
      return { ok: false, reason: 'needs_checkout' };
    }
  }

  const beforePricing = (current.meta_pricing ?? {}) as Record<string, unknown>;
  const nextPricing = params.metaPricing ?? beforePricing;

  const changed =
    nextMethod !== beforeMethod || !samePricing(nextPricing, beforePricing);
  if (!changed) {
    return {
      ok: true,
      changed: false,
      metaPricing: nextPricing as MetaPricing,
      paymentMethod: nextMethod,
    };
  }

  const logged = await recordPlatformAction({
    action: 'plan_override',
    actorUserId: params.actorUserId,
    accountId: params.accountId,
    accountName: params.accountName,
    reason: params.reason,
    details: {
      kind: 'meta_pricing',
      plan: current.plan_id,
      before: { meta_pricing: beforePricing, payment_method: beforeMethod },
      after: { meta_pricing: nextPricing, payment_method: nextMethod },
    },
  });
  if (!logged) return { ok: false, reason: 'audit_failed' };

  const { error } = await supabaseAdmin()
    .from('subscriptions')
    .update({ meta_pricing: nextPricing, payment_method: nextMethod })
    .eq('account_id', params.accountId);
  if (error) {
    console.error('[platform/managed-plan] pricing write failed:', error);
    throw error;
  }

  return {
    ok: true,
    changed: true,
    metaPricing: nextPricing as MetaPricing,
    paymentMethod: nextMethod,
  };
}
