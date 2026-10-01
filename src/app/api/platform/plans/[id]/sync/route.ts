// ============================================================
// POST /api/platform/plans/[id]/sync — publish one cycle of a plan to
// PayPal (fase 9, s9.3). Body: `{ cycle: 'month' | 'year' }`.
//
//   no PayPal id           → create the plan at PayPal, store the id   200
//   id at another price    → create a NEW PayPal plan, swap the id,
//                            archive the old one in the history        200
//   id at the same price   → nothing                                   200
//   price empty or 0       → 400 (nothing free is published)
//   no PayPal credentials  → 503
//   hidden plan            → 409 `hidden_plan`, unless the body says
//                            `confirmHidden: true` (s10.3): a plan that
//                            is not for sale is published only on
//                            purpose (the box in the dialog)
//
// `{ cycle, action: 'unpublish' }` stops selling that cycle: the id goes
// back to NULL, the history is kept, PayPal is not called.
//
// Subscribers already on the old PayPal plan stay there at the old
// price (decision 5): this route never touches a subscription. The rules
// live in `src/lib/billing/plan-sync.ts`.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { PLAN_ID_RE } from '@/lib/billing/plan-catalog';
import {
  loadPlatformPlan,
  PlanSyncError,
  syncPlanCycle,
  unpublishPlanCycle,
} from '@/lib/billing/plan-sync';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(
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
      `platform:plans:sync:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await context.params;
    if (!PLAN_ID_RE.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      cycle?: unknown;
      action?: unknown;
      confirmHidden?: unknown;
    } | null;
    const cycle = body?.cycle;
    if (cycle !== 'month' && cycle !== 'year') {
      return NextResponse.json(
        { error: "'cycle' must be 'month' or 'year'" },
        { status: 400 }
      );
    }

    const action = body?.action ?? 'sync';
    if (action !== 'sync' && action !== 'unpublish') {
      return NextResponse.json(
        { error: "'action' must be 'sync' or 'unpublish'" },
        { status: 400 }
      );
    }

    if (action === 'unpublish') {
      const result = await unpublishPlanCycle({ planId: id, cycle });
      const plan = await loadPlatformPlan(id);
      return NextResponse.json({ ...result, plan });
    }

    const result = await syncPlanCycle({
      planId: id,
      cycle,
      actorUserId: ctx.userId,
      allowHidden: body?.confirmHidden === true,
    });
    const plan = await loadPlatformPlan(id);
    return NextResponse.json({ ...result, plan });
  } catch (err) {
    if (err instanceof PlanSyncError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error('[POST /api/platform/plans/[id]/sync] failed:', err);
    return NextResponse.json(
      { error: 'Failed to sync the plan' },
      { status: 500 }
    );
  }
}
