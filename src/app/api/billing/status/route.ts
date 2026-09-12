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
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { getEntitlements } from '@/lib/billing/enforce';

interface SubscriptionDates {
  grace_until: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
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
        'grace_until, trial_ends_at, current_period_end, cancel_at_period_end'
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
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
