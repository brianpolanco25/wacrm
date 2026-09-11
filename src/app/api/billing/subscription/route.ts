// ============================================================
// /api/billing/subscription — the subscription area of Fase 3 §6.
//
//   GET  — plan, status, next charge, consumption against the plan's
//          limits, and the receipts of this account.
//   POST — cancel, reactivate, change plan.
//
// THE LINE THIS FILE MUST NOT CROSS
// --------------------------------
// Nothing here sets `status = 'active'`. Every action talks to PayPal
// and then waits: the webhook of §3 is still the only thing that turns
// a payment into service. The single local write in this file is
// `cancel_at_period_end = true` right after PayPal accepted a
// cancellation, and that one only ever takes entitlements AWAY — it is
// the flag that keeps serving the customer to the end of the cycle
// they already paid for while PayPal's `CANCELLED` event is in flight.
// `last_event_at` is deliberately NOT touched: this is not an event,
// and moving the watermark would make the real event look late.
//
// WHY `allowReadOnly: true` ON ALL OF IT
// --------------------------------------
// §5 says a `suspended` account behaves as if every member were a
// `viewer`, and §6 says that same account must see its subscription
// and the button to settle it. A billing area that 403s exactly when
// billing is broken is a locked door with the key inside. Same
// rationale — and the same precedent — as `POST /api/billing/checkout`,
// which f3.4 already exempted. None of these verbs writes tenant data;
// they act on the billing relationship itself, which is the way out of
// the lock.
//
// ISOLATION
// ---------
// `billing_events` is the only table here with no `account_id` at all:
// it is the provider's global log. The receipts of this account are
// resolved by first collecting THIS account's PayPal subscription ids
// (from `subscriptions` and `checkout_intents`, both scoped by
// `account_id`, both holding that id under a UNIQUE constraint) and
// then filtering the log by them in the database. No ids, no query —
// never a scan whose rows are filtered afterwards in our process.
// ============================================================

import { NextResponse } from 'next/server';

import {
  requireRole,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getEntitlements } from '@/lib/billing/enforce';
import { currentPeriodStart } from '@/lib/billing/entitlements';
import {
  activateSubscription,
  cancelSubscription,
  PayPalError,
  reviseSubscription,
} from '@/lib/billing/paypal';
import {
  checkoutUrls,
  isBillingCycle,
  providerPlanIdFor,
  resolveAppOrigin,
  type CheckoutPlanRow,
} from '@/lib/billing/checkout';
import {
  asCycle,
  availableActions,
  buildUsage,
  nextChargeAt,
  parseReceipt,
  type ReceiptRow,
  type SubscriptionShape,
} from '@/lib/billing/subscription-view';

const PROVIDER = 'paypal';

const SUBSCRIPTION_COLUMNS =
  'plan_id, status, provider, provider_subscription_id, current_period_end, ' +
  'grace_until, trial_ends_at, cancel_at_period_end, cycle';

const PLAN_COLUMNS =
  'id, name, is_public, price_usd_month, price_usd_year, ' +
  'provider_plan_id_month, provider_plan_id_year';

/** How many receipts the panel shows. Two years of monthly renewals. */
const RECEIPT_LIMIT = 24;

/** Reason string PayPal stores with the cancellation. */
const CANCEL_REASON = 'Cancelled by the customer from the app';
const REACTIVATE_REASON = 'Reactivated by the customer from the app';

interface SubscriptionRow {
  plan_id: string;
  status: string;
  provider: string;
  provider_subscription_id: string | null;
  current_period_end: string | null;
  grace_until: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean;
  cycle: string | null;
}

/** A read failed. Never conflated with "this account has nothing". */
class SubscriptionReadError extends Error {
  constructor(what: string) {
    super(`Failed to read ${what}`);
    this.name = 'SubscriptionReadError';
  }
}

async function loadSubscription(
  ctx: AccountContext
): Promise<SubscriptionRow | null> {
  const { data, error } = await ctx.supabase
    .from('subscriptions')
    .select(SUBSCRIPTION_COLUMNS)
    // Scoped by account on top of RLS. `subscriptions_select` (041)
    // already limits this to members; the explicit filter is the house
    // rule for anything billing-shaped.
    .eq('account_id', ctx.accountId)
    .maybeSingle();

  if (error) {
    console.error('[api/billing/subscription] subscription read error:', error);
    throw new SubscriptionReadError('the subscription');
  }
  return (data as SubscriptionRow | null) ?? null;
}

function shapeOf(row: SubscriptionRow | null): SubscriptionShape | null {
  return row
    ? {
        status: row.status,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        providerSubscriptionId: row.provider_subscription_id,
      }
    : null;
}

/**
 * Every PayPal subscription id this account has ever owned.
 *
 * Both tables constrain that id to be globally unique, so an id in
 * this list cannot belong to anyone else — which is what makes it safe
 * to use as the tenant filter over a log that has no `account_id`.
 * Cancelled and re-contracted subscriptions are included on purpose:
 * their payments are still this customer's receipts.
 */
async function ownedSubscriptionIds(
  ctx: AccountContext,
  subscription: SubscriptionRow | null
): Promise<string[]> {
  const ids = new Set<string>();
  if (subscription?.provider_subscription_id) {
    ids.add(subscription.provider_subscription_id);
  }

  const { data, error } = await ctx.supabase
    .from('checkout_intents')
    .select('provider_subscription_id')
    .eq('account_id', ctx.accountId)
    .eq('provider', PROVIDER);

  if (error) {
    console.error('[api/billing/subscription] intent read error:', error);
    throw new SubscriptionReadError('the checkout history');
  }

  for (const row of (data as { provider_subscription_id?: unknown }[]) ?? []) {
    if (
      typeof row?.provider_subscription_id === 'string' &&
      row.provider_subscription_id
    ) {
      ids.add(row.provider_subscription_id);
    }
  }
  return [...ids];
}

/**
 * The account's payments, from the gateway log.
 *
 * Service role, because `billing_events` has RLS enabled and no policy
 * at all (041): its payloads carry other tenants' data, so nobody
 * reads it from the browser. The tenant scope is the id list above,
 * applied as a database filter — an empty list short-circuits instead
 * of degrading into "everyone's receipts".
 */
async function loadReceipts(subscriptionIds: string[]): Promise<ReceiptRow[]> {
  if (subscriptionIds.length === 0) return [];

  const { data, error } = await supabaseAdmin()
    .from('billing_events')
    .select('id, payload, received_at')
    .eq('provider', PROVIDER)
    .eq('event_type', 'PAYMENT.SALE.COMPLETED')
    // The account filter. Migration 056 indexes exactly this
    // expression, restricted to this event type.
    .in('payload->resource->>billing_agreement_id', subscriptionIds)
    .order('received_at', { ascending: false })
    .limit(RECEIPT_LIMIT);

  if (error) {
    console.error('[api/billing/subscription] receipts read error:', error);
    throw new SubscriptionReadError('the receipts');
  }

  const rows =
    (data as { id: string; payload: unknown; received_at: string }[]) ?? [];
  return rows
    .map((row) => parseReceipt(row))
    .filter((r): r is ReceiptRow => r !== null);
}

/** Consumption of the current calendar month, verbatim. */
async function loadUsage(ctx: AccountContext) {
  const { data, error } = await ctx.supabase
    .from('usage_counters')
    .select('metric, value')
    .eq('account_id', ctx.accountId)
    .eq('period_start', currentPeriodStart());

  if (error) {
    console.error('[api/billing/subscription] usage read error:', error);
    throw new SubscriptionReadError('the usage counters');
  }
  return (data as { metric: string; value: number | string }[]) ?? [];
}

/** Display name of a catalogue plan; the id is not a name. */
async function loadPlanName(
  ctx: AccountContext,
  planId: string
): Promise<string | null> {
  const { data, error } = await ctx.supabase
    .from('plans')
    .select('id, name')
    .eq('id', planId)
    .maybeSingle();

  if (error) {
    console.error('[api/billing/subscription] plan name read error:', error);
    return null;
  }
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : null;
}

export async function GET() {
  try {
    const ctx = await requireRole('admin', { allowReadOnly: true });

    const subscription = await loadSubscription(ctx);
    // The same resolution the server enforces with, so the panel can
    // never disagree with a 402 the user just got.
    const entitlements = await getEntitlements(ctx.accountId);

    const [planName, counters, ids] = await Promise.all([
      loadPlanName(ctx, entitlements.planId),
      loadUsage(ctx),
      ownedSubscriptionIds(ctx, subscription),
    ]);
    const receipts = await loadReceipts(ids);

    const shape = shapeOf(subscription);

    return NextResponse.json({
      planId: entitlements.planId,
      planName,
      status: entitlements.status,
      readOnly: entitlements.readOnly,
      cycle: asCycle(subscription?.cycle),
      cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
      currentPeriodEnd: subscription?.current_period_end ?? null,
      graceUntil: subscription?.grace_until ?? null,
      trialEndsAt: entitlements.trialEndsAt,
      nextChargeAt: nextChargeAt({
        status: entitlements.status,
        cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
        currentPeriodEnd: subscription?.current_period_end ?? null,
      }),
      usage: buildUsage(entitlements.limits, counters),
      receipts,
      actions: availableActions(shape),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ------------------------------------------------------------
// Actions
// ------------------------------------------------------------

type Action = 'cancel' | 'reactivate' | 'change_plan';

function isAction(value: unknown): value is Action {
  return (
    value === 'cancel' || value === 'reactivate' || value === 'change_plan'
  );
}

/** PayPal refused. 502, with its reason in the log and not on the wire. */
function gatewayError(err: PayPalError, what: string) {
  console.error(
    `[api/billing/subscription] PayPal refused to ${what}:`,
    err.status,
    err.body
  );
  return NextResponse.json(
    { error: 'The payment provider refused the request' },
    { status: 502 }
  );
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin', { allowReadOnly: true });

    const limit = checkRateLimit(
      `admin:billingSubscription:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      planId?: unknown;
      cycle?: unknown;
    } | null;

    if (!isAction(body?.action)) {
      return NextResponse.json(
        { error: "'action' must be 'cancel', 'reactivate' or 'change_plan'" },
        { status: 400 }
      );
    }

    const subscription = await loadSubscription(ctx);
    const actions = availableActions(shapeOf(subscription));
    const providerSubscriptionId =
      subscription?.provider_subscription_id ?? null;

    if (body.action === 'cancel') {
      if (!actions.cancel || !providerSubscriptionId) {
        return NextResponse.json(
          { error: 'There is no active subscription to cancel' },
          { status: 409 }
        );
      }

      try {
        await cancelSubscription(providerSubscriptionId, CANCEL_REASON);
      } catch (err) {
        if (err instanceof PayPalError) {
          // 422 UNPROCESSABLE means PayPal had already cancelled it
          // (the customer did it from their PayPal account, a redelivery
          // we have not seen yet). The intent matches the state, so the
          // local flag is still set instead of showing an error.
          if (err.status !== 422) return gatewayError(err, 'cancel');
        } else {
          throw err;
        }
      }

      // The ONLY local write of this file, and it only takes away:
      // service continues to `current_period_end` and there will be no
      // further charge. The status is left alone — PayPal's `CANCELLED`
      // event decides that, and it is what the spec's table says.
      const { error } = await supabaseAdmin()
        .from('subscriptions')
        .update({ cancel_at_period_end: true })
        .eq('account_id', ctx.accountId);

      if (error) {
        console.error(
          '[api/billing/subscription] could not flag the cancellation:',
          error
        );
        // PayPal already cancelled. Saying "it failed" would invite a
        // second attempt on a subscription that no longer exists; the
        // webhook sets the same flag when its event lands.
        return NextResponse.json(
          {
            status: 'cancelled_at_provider',
            note: 'PayPal cancelled the subscription; the local flag will follow with the event',
          },
          { status: 200 }
        );
      }

      return NextResponse.json({ status: 'cancelled_at_period_end' });
    }

    if (body.action === 'reactivate') {
      if (actions.reactivate !== 'activate' || !providerSubscriptionId) {
        return NextResponse.json(
          {
            error:
              'This subscription cannot be resumed; contract a plan again instead',
            mode: actions.reactivate ?? 'checkout',
          },
          { status: 409 }
        );
      }

      try {
        await activateSubscription(providerSubscriptionId, REACTIVATE_REASON);
      } catch (err) {
        if (err instanceof PayPalError) return gatewayError(err, 'reactivate');
        throw err;
      }

      // Nothing is written. PayPal emits ACTIVATED and the webhook is
      // what lifts the status — the same rule as the return page of §2.
      return NextResponse.json({ status: 'reactivation_requested' });
    }

    // ---- change_plan -------------------------------------------------
    if (actions.changePlan !== 'revise' || !providerSubscriptionId) {
      return NextResponse.json(
        {
          error:
            'There is no live subscription to move; contract the plan instead',
          mode: 'checkout',
        },
        { status: 409 }
      );
    }

    const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
    if (!planId) {
      return NextResponse.json(
        { error: "'planId' is required" },
        { status: 400 }
      );
    }
    if (!isBillingCycle(body.cycle)) {
      return NextResponse.json(
        { error: "'cycle' must be 'month' or 'year'" },
        { status: 400 }
      );
    }
    const cycle = body.cycle;

    if (
      subscription &&
      subscription.plan_id === planId &&
      asCycle(subscription.cycle) === cycle
    ) {
      return NextResponse.json(
        { error: 'That is already the current plan' },
        { status: 409 }
      );
    }

    const { data: planData, error: planError } = await ctx.supabase
      .from('plans')
      .select(PLAN_COLUMNS)
      .eq('id', planId)
      .maybeSingle();

    if (planError) {
      console.error('[api/billing/subscription] plan read error:', planError);
      return NextResponse.json(
        { error: 'Failed to load the plan catalogue' },
        { status: 500 }
      );
    }
    const plan = planData as CheckoutPlanRow | null;
    if (!plan || !plan.is_public) {
      return NextResponse.json({ error: 'Unknown plan' }, { status: 404 });
    }

    const providerPlanId = providerPlanIdFor(plan, cycle);
    if (!providerPlanId) {
      return NextResponse.json(
        { error: 'This plan is not available for that billing cycle yet' },
        { status: 409 }
      );
    }

    const { returnUrl, cancelUrl } = checkoutUrls(resolveAppOrigin(request));

    let revision;
    try {
      revision = await reviseSubscription({
        subscriptionId: providerSubscriptionId,
        planId: providerPlanId,
        returnUrl,
        cancelUrl,
      });
    } catch (err) {
      if (err instanceof PayPalError) return gatewayError(err, 'change plan');
      throw err;
    }

    // Still no local write. If PayPal wants approval, nothing has
    // changed there either yet; if it does not, `BILLING.SUBSCRIPTION.
    // UPDATED` is on its way and reconciles plan and cycle. Writing
    // `plan_id` here would hand the customer a tier they may never
    // approve — the exact mistake the return page of §2 exists to avoid.
    return NextResponse.json({
      status: revision.approvalUrl ? 'approval_required' : 'change_requested',
      approvalUrl: revision.approvalUrl,
      planId: plan.id,
      cycle,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
