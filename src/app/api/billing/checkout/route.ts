// ============================================================
// /api/billing/checkout — contracting a plan (Fase 3 §2).
//
//   POST — create the subscription in PayPal and hand back the
//          approval link. Records the intent (account, plan, cycle,
//          provider subscription id) so the webhook of §3 can match
//          the event with a tenant.
//   GET  — read-only status for the page PayPal returns to.
//
// THE LINE THIS FILE MUST NOT CROSS
// --------------------------------
// Neither verb writes to `subscriptions`. The customer coming back
// from PayPal proves nothing: they may close the browser after paying
// (and would then be left without service if the return URL were the
// activator), and anyone can call a return URL by hand (and would then
// be handing themselves a plan). Activation belongs to the webhook,
// which is Fase 3 §3.
//
// Writes go through the service-role client because
// `checkout_intents` has no write policy at all (migration 048): a
// tenant who could insert there would claim someone else's paid
// subscription. Every such query is scoped by the `account_id` of the
// authenticated context — never by anything from the request body.
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
import { createSubscription, PayPalError } from '@/lib/billing/paypal';
import {
  alreadyContracted,
  checkoutRequestId,
  checkoutUrls,
  isBillingCycle,
  priceFor,
  providerPlanIdFor,
  resolveAppOrigin,
  type CheckoutPlanRow,
  type CheckoutSubscriptionRow,
} from '@/lib/billing/checkout';

const PLAN_COLUMNS =
  'id, name, is_public, price_usd_month, price_usd_year, provider_plan_id_month, provider_plan_id_year';
const INTENT_COLUMNS =
  'id, plan_id, cycle, status, provider, provider_subscription_id, created_at';
const SUBSCRIPTION_COLUMNS =
  'plan_id, status, provider_subscription_id, current_period_end, cancel_at_period_end';

/** Brand shown on PayPal's approval screen. */
const BRAND_NAME = 'wacrm';

interface IntentRow {
  id: string;
  plan_id: string;
  cycle: string;
  status: string;
  provider: string;
  provider_subscription_id: string;
  created_at: string;
}

interface SubscriptionRow extends CheckoutSubscriptionRow {
  plan_id: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

/** Shape the intent row for the wire. Never leaks another account's. */
function intentPayload(row: IntentRow) {
  return {
    planId: row.plan_id,
    cycle: row.cycle,
    status: row.status,
    subscriptionId: row.provider_subscription_id,
    createdAt: row.created_at,
  };
}

/**
 * The caller's own subscription row, scoped by account both in the
 * query and by RLS. Returns null when the account has none yet.
 */
async function loadSubscription(
  ctx: AccountContext
): Promise<SubscriptionRow | null> {
  const { data, error } = await ctx.supabase
    .from('subscriptions')
    .select(SUBSCRIPTION_COLUMNS)
    .eq('account_id', ctx.accountId)
    .maybeSingle();

  if (error) {
    console.error('[api/billing/checkout] subscription fetch error:', error);
    return null;
  }
  return (data as SubscriptionRow | null) ?? null;
}

export async function POST(request: Request) {
  try {
    // admin+ only: contracting spends the tenant's money.
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:billingCheckout:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      planId?: unknown;
      cycle?: unknown;
    } | null;

    const planId = typeof body?.planId === 'string' ? body.planId.trim() : '';
    if (!planId) {
      return NextResponse.json(
        { error: "'planId' is required" },
        { status: 400 }
      );
    }
    if (!isBillingCycle(body?.cycle)) {
      return NextResponse.json(
        { error: "'cycle' must be 'month' or 'year'" },
        { status: 400 }
      );
    }
    const cycle = body.cycle;

    const { data: planData, error: planError } = await ctx.supabase
      .from('plans')
      .select(PLAN_COLUMNS)
      .eq('id', planId)
      .maybeSingle();

    if (planError) {
      console.error(
        '[POST /api/billing/checkout] plan fetch error:',
        planError
      );
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
    if (!providerPlanId || !priceFor(plan, cycle)) {
      // The catalogue has no PayPal plan for this cycle yet. Nothing
      // the customer can do about it; say so instead of 500-ing.
      return NextResponse.json(
        { error: 'This plan is not available for that billing cycle yet' },
        { status: 409 }
      );
    }

    // Already paying? A second PayPal subscription would be a second
    // charge: PayPal cannot swap plans in place, so changing plan is
    // the settings flow (Fase 3 §6), not another checkout.
    const existing = await loadSubscription(ctx);
    if (alreadyContracted(existing)) {
      return NextResponse.json(
        {
          error:
            'This account already has an active subscription. Change the plan from Settings instead.',
        },
        { status: 409 }
      );
    }

    const origin = resolveAppOrigin(request);
    const { returnUrl, cancelUrl } = checkoutUrls(origin);

    let subscription;
    try {
      subscription = await createSubscription({
        planId: providerPlanId,
        // Echoed back on every webhook event: a second way to resolve
        // the account if the intent row were ever missing.
        customId: ctx.accountId,
        returnUrl,
        cancelUrl,
        brandName: BRAND_NAME,
        requestId: checkoutRequestId(ctx.accountId, plan.id, cycle),
      });
    } catch (err) {
      if (err instanceof PayPalError) {
        console.error(
          '[POST /api/billing/checkout] PayPal refused the subscription:',
          err.status,
          err.body
        );
        return NextResponse.json(
          { error: 'The payment provider refused to start the checkout' },
          { status: 502 }
        );
      }
      throw err;
    }

    const admin = supabaseAdmin();
    const { data: inserted, error: insertError } = await admin
      .from('checkout_intents')
      .insert({
        account_id: ctx.accountId,
        plan_id: plan.id,
        cycle,
        provider: 'paypal',
        provider_plan_id: providerPlanId,
        provider_subscription_id: subscription.id,
        created_by: ctx.userId,
        status: 'pending',
      })
      .select(INTENT_COLUMNS)
      .single();

    let intent = inserted as IntentRow | null;

    if (insertError) {
      // 23505: PayPal replayed an earlier request id and handed back a
      // subscription we already recorded (double click, retried POST).
      // Read our row back instead of overwriting it — its `status` may
      // already have been moved on by the webhook.
      if (insertError.code === '23505') {
        const { data: existingIntent } = await admin
          .from('checkout_intents')
          .select(INTENT_COLUMNS)
          .eq('account_id', ctx.accountId)
          .eq('provider', 'paypal')
          .eq('provider_subscription_id', subscription.id)
          .maybeSingle();
        intent = (existingIntent as IntentRow | null) ?? null;
      }
      if (!intent) {
        console.error(
          '[POST /api/billing/checkout] intent insert error:',
          insertError
        );
        // Fail closed. The PayPal subscription stays APPROVAL_PENDING
        // and expires unused; handing out a link we cannot reconcile
        // would risk a payment nobody can match to an account.
        return NextResponse.json(
          { error: 'Could not start the checkout' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      {
        approvalUrl: subscription.approvalUrl,
        subscriptionId: subscription.id,
        planId: plan.id,
        cycle,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Read-only status for `/billing/return`. Answers "has the webhook
 * arrived yet?" and nothing else — it cannot activate, extend or
 * modify anything. `subscription_id` narrows to one attempt; without
 * it the caller gets their most recent one.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const subscriptionId = new URL(request.url).searchParams
      .get('subscription_id')
      ?.trim();

    let query = ctx.supabase
      .from('checkout_intents')
      .select(INTENT_COLUMNS)
      // Scoped by account on top of RLS: this route reads billing data
      // and a missing filter here is a cross-tenant leak.
      .eq('account_id', ctx.accountId);

    if (subscriptionId) {
      query = query.eq('provider_subscription_id', subscriptionId);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('[GET /api/billing/checkout] intent fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load the checkout status' },
        { status: 500 }
      );
    }

    const intent = ((data as IntentRow[] | null) ?? [])[0] ?? null;
    const subscription = await loadSubscription(ctx);

    // "Activated" means the webhook did it, and did it for *this*
    // attempt: the provider id on our subscription row is the one the
    // customer just approved.
    const activated = Boolean(
      subscription &&
      subscription.status === 'active' &&
      (!intent ||
        subscription.provider_subscription_id ===
          intent.provider_subscription_id)
    );

    return NextResponse.json({
      intent: intent ? intentPayload(intent) : null,
      subscription: subscription
        ? {
            planId: subscription.plan_id,
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          }
        : null,
      activated,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
