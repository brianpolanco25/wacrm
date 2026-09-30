// ============================================================
// PATCH /api/platform/plans/[id] — edit a plan (fase 9, s9.3).
//
// Same fields as the create, any subset; the id is the URL and does not
// change (a body `id` is a 400). Editing a price does NOT touch PayPal:
// the plan shows «precio desincronizado» until the operator syncs it,
// which is a separate, confirmed action (`./sync`).
//
// No DELETE handler, on purpose: a plan is unpublished, not deleted.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { PLAN_ID_RE, validatePlanInput } from '@/lib/billing/plan-catalog';
import { updateCatalogPlan } from '@/lib/platform/plans';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let ctx;
  try {
    ctx = await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    throw err;
  }

  try {
    const limit = checkRateLimit(
      `platform:plans:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await context.params;
    if (!PLAN_ID_RE.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const input = validatePlanInput(body, 'update');
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: 400 });
    }

    const plan = await updateCatalogPlan(id, input.value);
    if (!plan) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ plan });
  } catch (err) {
    console.error('[PATCH /api/platform/plans/[id]] failed:', err);
    return NextResponse.json(
      { error: 'Failed to update the plan' },
      { status: 500 }
    );
  }
}
