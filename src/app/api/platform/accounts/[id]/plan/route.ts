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
//
// s10.3 — a plan with a Meta price policy (`gestionado`, 077) needs the
// terms of the managed billing, and is refused without them (400):
//
//   { planId, reason,
//     paymentMethod: 'manual' | 'paypal',
//     metaBilling?:  'managed' | 'direct'   (default 'managed'),
//     metaPricing?:  {...}                  (default: the plan's) }
//
//   manual  `provider = 'manual'`, `active`, monthly, the first cut-off
//           one month from now, the price on the row. 200.
//   paypal  the plan is published to PayPal if it is not yet (s9.3), a
//           subscription is created for this account and the account
//           stays `incomplete` until the webhook activates it (s9.6).
//           200 with `approvalUrl`: the operator sends it to the owner.
//
// `metaPricing` is validated with `parseMetaPricing` (400 with the
// reason). Every other plan keeps the s9.4 behaviour, and leaves the
// managed billing (`direct`).
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { resolveAppOrigin } from '@/lib/billing/checkout';
import type { MetaBilling } from '@/lib/billing/entitlements';
import { parseMetaPricing, type MetaPricing } from '@/lib/billing/meta-pricing';
import { PayPalError } from '@/lib/billing/paypal';
import { PlanSyncError } from '@/lib/billing/plan-sync';
import { loadAccountSummary } from '@/lib/platform/accounts';
import { MIN_REASON_LENGTH } from '@/lib/platform/audit';
import { assignManagedPlanViaPayPal } from '@/lib/platform/managed-plan';
import { overridePlan } from '@/lib/platform/provisioning';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Terms =
  | { kind: 'none' }
  | {
      kind: 'managed';
      paymentMethod: 'manual' | 'paypal';
      metaBilling: MetaBilling;
      metaPricing: MetaPricing | null;
    }
  | { kind: 'invalid'; error: string };

/** The s10.3 fields of the body, validated. */
function readTerms(body: Record<string, unknown> | null): Terms {
  const hasTerms =
    body !== null &&
    ('paymentMethod' in body || 'metaBilling' in body || 'metaPricing' in body);
  if (!hasTerms) return { kind: 'none' };

  const paymentMethod = body.paymentMethod;
  if (paymentMethod !== 'manual' && paymentMethod !== 'paypal') {
    return {
      kind: 'invalid',
      error: "'paymentMethod' must be 'manual' or 'paypal'",
    };
  }
  const metaBilling = body.metaBilling ?? 'managed';
  if (metaBilling !== 'managed' && metaBilling !== 'direct') {
    return {
      kind: 'invalid',
      error: "'metaBilling' must be 'managed' or 'direct'",
    };
  }
  let metaPricing: MetaPricing | null = null;
  if (body.metaPricing !== undefined && metaBilling === 'managed') {
    const parsed = parseMetaPricing(body.metaPricing);
    if (!parsed.ok) {
      return { kind: 'invalid', error: `metaPricing: ${parsed.error}` };
    }
    if (!parsed.value) {
      return {
        kind: 'invalid',
        error: 'metaPricing cannot be empty when Cabbity pays Meta',
      };
    }
    metaPricing = parsed.value;
  }
  return { kind: 'managed', paymentMethod, metaBilling, metaPricing };
}

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

    const raw = await request.json().catch(() => null);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;

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

    const terms = readTerms(body);
    if (terms.kind === 'invalid') {
      return NextResponse.json({ error: terms.error }, { status: 400 });
    }

    const account = await loadAccountSummary(id);
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (terms.kind === 'managed' && terms.paymentMethod === 'paypal') {
      return await assignWithPayPal(request, {
        accountId: id,
        accountName: account.name,
        planId,
        actorUserId: ctx.userId,
        reason,
        metaBilling: terms.metaBilling,
        metaPricing: terms.metaPricing,
      });
    }

    const outcome = await overridePlan({
      accountId: id,
      accountName: account.name,
      planId,
      actorUserId: ctx.userId,
      reason,
      ...(terms.kind === 'managed'
        ? {
            terms: {
              paymentMethod: 'manual' as const,
              metaBilling: terms.metaBilling,
              metaPricing: terms.metaPricing,
            },
          }
        : {}),
    });

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'unknown_plan':
          return NextResponse.json({ error: 'Unknown plan' }, { status: 400 });
        case 'needs_terms':
          return NextResponse.json(
            {
              error:
                "This plan bills Meta through Cabbity: say how it is paid ('paymentMethod') and its price",
              code: 'needs_terms',
            },
            { status: 400 }
          );
        case 'no_pricing':
          return NextResponse.json(
            {
              error: 'This plan has no Meta price policy to start from',
              code: 'no_pricing',
            },
            { status: 400 }
          );
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
      ...(terms.kind === 'managed' ? { paymentMethod: 'manual' } : {}),
    });
  } catch (err) {
    console.error('[POST /api/platform/accounts/[id]/plan] failed:', err);
    return NextResponse.json(
      { error: 'Failed to assign the plan' },
      { status: 500 }
    );
  }
}

/** The `paypal` branch: publish if needed, subscribe, hand back the link. */
async function assignWithPayPal(
  request: Request,
  params: {
    accountId: string;
    accountName: string;
    planId: string;
    actorUserId: string;
    reason: string;
    metaBilling: MetaBilling;
    metaPricing: MetaPricing | null;
  }
) {
  let outcome;
  try {
    outcome = await assignManagedPlanViaPayPal({
      ...params,
      origin: resolveAppOrigin(request),
    });
  } catch (err) {
    if (err instanceof PlanSyncError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    if (err instanceof PayPalError) {
      if (err.status === 0) {
        return NextResponse.json(
          {
            error: 'PayPal is not configured on this server',
            code: 'paypal_not_configured',
          },
          { status: 503 }
        );
      }
      console.error(
        '[POST /api/platform/accounts/[id]/plan] PayPal refused the subscription:',
        err.status,
        err.body
      );
      return NextResponse.json(
        {
          error: 'PayPal refused to create the subscription; nothing changed',
          code: 'paypal_failed',
        },
        { status: 502 }
      );
    }
    throw err;
  }

  if (!outcome.ok) {
    switch (outcome.reason) {
      case 'unknown_plan':
        return NextResponse.json({ error: 'Unknown plan' }, { status: 400 });
      case 'not_managed_plan':
        return NextResponse.json(
          {
            error:
              'Only a plan with a Meta price policy is assigned with PayPal from here; the others are contracted by the company at /billing',
            code: 'not_managed_plan',
          },
          { status: 400 }
        );
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
    accountId: params.accountId,
    planId: params.planId,
    provider: 'paypal',
    status: 'incomplete',
    paymentMethod: 'paypal',
    approvalUrl: outcome.approvalUrl,
    subscriptionId: outcome.subscriptionId,
    published: outcome.published,
    fromPlan: outcome.fromPlan,
    fromProvider: outcome.fromProvider,
  });
}
