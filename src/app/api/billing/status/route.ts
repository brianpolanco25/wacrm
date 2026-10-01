// ============================================================
// GET /api/billing/status — "can this account still write, and why
// not?" (Fase 3 §5).
//
// The dunning banner needs one thing the plan catalogue cannot give
// it: the account's own subscription state, resolved through the same
// entitlements layer the server enforces with. If the banner asked
// `subscriptions` directly it would have to re-implement
// `isReadOnly` in the browser, and the two would drift.
//
// Open to any member (`getCurrentAccount`, no role floor): a `viewer`
// is exactly who needs to be told why nothing saves. It exposes no
// money figures and no provider ids — status, plan and dates only.
// Changing the subscription is not possible from here; this route has
// no writes at all.
//
// p11.1: the same body also says whether the account's WhatsApp numbers
// have a payment method in Meta (`metaPayment`) and who pays Meta
// (`metaBilling`). Read from what the server stored in `whatsapp_config`
// (migration 079) — this route NEVER calls Meta — so the banner costs no
// request of its own. A failure reading it means "no banner", never a
// 500: Cabbity's own dunning banner must not fall because of this.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { getEntitlements } from '@/lib/billing/enforce';
import { getPlatformSignupConfig } from '@/lib/whatsapp/platform-mode';
import {
  isPaymentCheckDisabled,
  metaBillingOf,
  metaPaymentBanner,
} from '@/lib/whatsapp/payment-method';

interface SubscriptionDates {
  grace_until: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  meta_billing?: string | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // Scoped by account on top of RLS — `subscriptions_select` (041)
    // already limits this to members, and the explicit filter is the
    // house rule for anything billing-shaped.
    const { data, error } = await ctx.supabase
      .from('subscriptions')
      .select(
        'grace_until, trial_ends_at, current_period_end, cancel_at_period_end, meta_billing'
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error(
        '[GET /api/billing/status] subscription fetch error:',
        error
      );
      return NextResponse.json(
        { error: 'Failed to load the subscription status' },
        { status: 500 }
      );
    }

    const dates = (data as SubscriptionDates | null) ?? null;
    const entitlements = await getEntitlements(ctx.accountId);

    // p11.1 (R14–R19). `meta_billing` exists since 076; `metaBillingOf`
    // still reads anything that is not 'managed' as 'direct'. When s10.3
    // exposes `entitlements.metaBilling`, read it from there instead.
    const metaBilling = metaBillingOf(
      dates as unknown as Record<string, unknown> | null
    );
    let metaPayment: ReturnType<typeof metaPaymentBanner> = {
      banner: null,
      missingNumbers: 0,
    };
    const disabled = isPaymentCheckDisabled();
    if (!disabled && metaBilling === 'direct') {
      try {
        // RLS (`whatsapp_config_select`, 017) plus the explicit filter.
        const { data: numbers, error: numbersError } = await ctx.supabase
          .from('whatsapp_config')
          .select('status, provisioned_via, meta_payment_status')
          .eq('account_id', ctx.accountId);
        if (numbersError) throw new Error(numbersError.message);
        metaPayment = metaPaymentBanner(
          (numbers ?? []) as Parameters<typeof metaPaymentBanner>[0],
          {
            metaBilling,
            platformMode: getPlatformSignupConfig() !== null,
            disabled,
          }
        );
      } catch (err) {
        console.error(
          '[GET /api/billing/status] payment status fetch error:',
          err instanceof Error ? err.message : 'Unknown error'
        );
      }
    }

    return NextResponse.json({
      planId: entitlements.planId,
      status: entitlements.status,
      // The single flag the banner branches on. Derived server-side so
      // the browser never re-implements the grace-period arithmetic.
      readOnly: entitlements.readOnly,
      // Fase 4 §2: the lock can also be a platform operator's manual
      // hold (migration 058), and that one is NOT settled at
      // `/billing` — pointing the tenant at a checkout would be a dead
      // end. The reason travels so the banner can say the right thing.
      // The operator's own wording is deliberately NOT exposed: it is
      // an internal note ("chargebacks, ticket 88") written for other
      // operators, not a customer-facing message.
      manualHold: entitlements.manualHold,
      readOnlyReason: entitlements.readOnlyReason,
      graceUntil: dates?.grace_until ?? null,
      trialEndsAt: entitlements.trialEndsAt,
      currentPeriodEnd: dates?.current_period_end ?? null,
      cancelAtPeriodEnd: dates?.cancel_at_period_end ?? false,
      metaPayment,
      metaBilling,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
