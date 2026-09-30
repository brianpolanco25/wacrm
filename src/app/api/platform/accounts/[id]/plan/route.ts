// ============================================================
// POST /api/platform/accounts/[id]/plan — give a company a plan by
// hand (s9.4, «Asignar plan a mano»).
//
// Body: `{ planId, reason }`.
//
// The subscription row becomes `provider = 'manual'`, `status = 'active'`
// with every gateway field cleared (see `manualPlanRow`). It is what puts
// a partner — or the owner's own company — on a plan without PayPal and
// without touching the database by hand. The Resumen leaves these out of
// the MRR (069) and the file shows them as «Asignado a mano».
//
// What it refuses:
//   - a subscription PayPal is still billing (a gateway id, `active` or
//     `past_due`): 409. Overwriting it would leave PayPal charging a
//     customer the database has forgotten. Cancel it at PayPal first; this
//     route does not cancel anything.
//   - no reason, or a short one: 400, same minimum as the rest of the log.
//
// What it leaves alone: `manual_hold_*`. A suspension is its own axis
// (058) and giving a plan must not lift it as a side effect.
//
// The bitácora row (`plan_override`, with from/to plan and the previous
// provider) is written BEFORE the change, as `[id]/hold` does.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { loadAccountSummary } from '@/lib/platform/accounts';
import { MIN_REASON_LENGTH } from '@/lib/platform/audit';
import { overridePlan } from '@/lib/platform/provisioning';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      `platform:plan:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      planId?: unknown;
      reason?: unknown;
    } | null;

    const planId = typeof body?.planId === 'string' ? body.planId.trim() : '';
    if (!planId) {
      return NextResponse.json(
        { error: "'planId' is required" },
        { status: 400 }
      );
    }

    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH) {
      return NextResponse.json(
        {
          error: `reason is required and must be at least ${MIN_REASON_LENGTH} characters`,
        },
        { status: 400 }
      );
    }

    const account = await loadAccountSummary(id);
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const outcome = await overridePlan({
      accountId: id,
      accountName: account.name,
      planId,
      actorUserId: ctx.userId,
      reason,
    });

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'unknown_plan':
          return NextResponse.json({ error: 'Unknown plan' }, { status: 400 });
        case 'paypal_active':
          return NextResponse.json(
            {
              error:
                'This company has a PayPal subscription that is still billing. Cancel it at PayPal first; nothing was changed.',
              code: 'paypal_active',
            },
            { status: 409 }
          );
        case 'audit_failed':
          return NextResponse.json(
            { error: 'Could not record the action; nothing was changed' },
            { status: 500 }
          );
      }
    }

    return NextResponse.json({
      accountId: id,
      planId,
      provider: 'manual',
      status: 'active',
      fromPlan: outcome.fromPlan,
      fromProvider: outcome.fromProvider,
    });
  } catch (err) {
    console.error('[POST /api/platform/accounts/[id]/plan] failed:', err);
    return NextResponse.json(
      { error: 'Failed to assign the plan' },
      { status: 500 }
    );
  }
}
