// ============================================================
// /api/billing/plans — the catalogue the plan picker renders.
//
// GET is open to any member of an account (the price list is not a
// secret; the `plans` RLS policy of migration 041 already lets any
// authenticated user read it). This route exists anyway for one
// reason: it turns `provider_plan_id_month` / `_year` into booleans.
// Those ids are what a checkout is created against, and there is no
// reason for a browser to ever hold one.
//
// It is read-only. Nothing about billing changes here.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  priceFor,
  providerPlanIdFor,
  type CheckoutPlanRow,
} from '@/lib/billing/checkout';

const PLAN_COLUMNS =
  'id, name, is_public, sort_order, limits, price_usd_month, price_usd_year, provider_plan_id_month, provider_plan_id_year';

interface CataloguePlanRow extends CheckoutPlanRow {
  sort_order: number;
  limits: Record<string, number | null> | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('plans')
      .select(PLAN_COLUMNS)
      .eq('is_public', true)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('[GET /api/billing/plans] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load the plan catalogue' },
        { status: 500 }
      );
    }

    const plans = ((data as CataloguePlanRow[] | null) ?? []).map((plan) => ({
      id: plan.id,
      name: plan.name,
      limits: plan.limits ?? {},
      priceMonth: priceFor(plan, 'month'),
      priceYear: priceFor(plan, 'year'),
      // Contractable only when the catalogue in PayPal has a plan for
      // that cycle AND we advertise a price for it.
      availableCycles: {
        month: Boolean(
          providerPlanIdFor(plan, 'month') && priceFor(plan, 'month')
        ),
        year: Boolean(
          providerPlanIdFor(plan, 'year') && priceFor(plan, 'year')
        ),
      },
    }));

    return NextResponse.json({ plans });
  } catch (err) {
    return toErrorResponse(err);
  }
}
