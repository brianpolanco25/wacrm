// ============================================================
// /api/platform/plans — the plan catalogue from the operator's panel
// (fase 9, s9.3).
//
//   GET   every plan, public or not, with its PayPal sync state per
//         cycle and the history of PayPal ids; plus `providerEnv`
//         (`PAYPAL_ENV`) so the page says which PayPal it talks to.
//   POST  create a plan. The id is a slug and never changes.
//
// Both start with `requirePlatformAdmin()`: owning a company buys
// nothing here (403). The writes use the service role because `plans`
// has no write policy, and keeps none. There is no DELETE — see
// `src/lib/platform/plans.ts`.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { validatePlanInput } from '@/lib/billing/plan-catalog';
import {
  currentPayPalEnv,
  loadPlatformPlans,
  paypalConfigured,
} from '@/lib/billing/plan-sync';
import { createCatalogPlan, PlanExistsError } from '@/lib/platform/plans';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

function isAuthError(err: unknown): boolean {
  return err instanceof UnauthorizedError || err instanceof ForbiddenError;
}

export async function GET() {
  try {
    await requirePlatformAdmin();
    const plans = await loadPlatformPlans();
    return NextResponse.json({
      providerEnv: currentPayPalEnv(),
      paypalConfigured: paypalConfigured(),
      plans,
    });
  } catch (err) {
    if (isAuthError(err)) return toErrorResponse(err);
    console.error('[GET /api/platform/plans] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the plans' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requirePlatformAdmin();
  } catch (err) {
    if (isAuthError(err)) return toErrorResponse(err);
    throw err;
  }

  try {
    const limit = checkRateLimit(
      `platform:plans:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const input = validatePlanInput(body, 'create');
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: 400 });
    }

    const plan = await createCatalogPlan(input.value);
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof PlanExistsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error('[POST /api/platform/plans] failed:', err);
    return NextResponse.json(
      { error: 'Failed to create the plan' },
      { status: 500 }
    );
  }
}
