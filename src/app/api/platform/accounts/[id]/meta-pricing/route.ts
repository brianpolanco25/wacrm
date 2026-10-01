// ============================================================
// PATCH /api/platform/accounts/[id]/meta-pricing — the price and the
// payment method of an account already on managed Meta billing
// (fase 10, s10.3, «Precio de Meta gestionado» on the file).
//
// Body: `{ reason, metaPricing?, paymentMethod? }` (at least one of the
// two). `metaPricing` is validated with `parseMetaPricing` and cannot be
// empty: an account Cabbity pays Meta for always has a price.
//
// A change applies from the next statement on: the statements already
// issued (s10.4) keep the figures they were issued with.
//
// What it refuses:
//   - an account that is not `meta_billing = 'managed'`: 409
//     `not_managed` (give it the managed plan first);
//   - `paymentMethod: 'manual'` while PayPal is still billing the fee:
//     409 `paypal_active` — the statement would charge the fee again;
//   - `paymentMethod: 'paypal'` with no live PayPal subscription: 409
//     `needs_checkout` — nobody would charge the fee. Assign the plan with
//     PayPal from the file, which creates the subscription;
//   - no reason, or a short one: 400, same minimum as the rest of the log.
//
// The bitácora row (`plan_override`, `details.kind = 'meta_pricing'`,
// with before and after) is written BEFORE the change.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import type { PaymentMethod } from '@/lib/billing/entitlements';
import { parseMetaPricing, type MetaPricing } from '@/lib/billing/meta-pricing';
import { loadAccountSummary } from '@/lib/platform/accounts';
import { MIN_REASON_LENGTH } from '@/lib/platform/audit';
import { updateManagedPricing } from '@/lib/platform/managed-plan';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      `platform:meta-pricing:${ctx.userId}`,
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
    if (!body) {
      return NextResponse.json(
        { error: 'body must be a JSON object' },
        { status: 400 }
      );
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH) {
      return NextResponse.json(
        {
          error: `reason is required and must be at least ${MIN_REASON_LENGTH} characters`,
        },
        { status: 400 }
      );
    }

    let metaPricing: MetaPricing | undefined;
    if (body.metaPricing !== undefined) {
      const parsed = parseMetaPricing(body.metaPricing);
      if (!parsed.ok) {
        return NextResponse.json(
          { error: `metaPricing: ${parsed.error}` },
          { status: 400 }
        );
      }
      if (!parsed.value) {
        return NextResponse.json(
          { error: 'metaPricing cannot be empty for a managed account' },
          { status: 400 }
        );
      }
      metaPricing = parsed.value;
    }

    let paymentMethod: PaymentMethod | undefined;
    if (body.paymentMethod !== undefined) {
      if (body.paymentMethod !== 'manual' && body.paymentMethod !== 'paypal') {
        return NextResponse.json(
          { error: "'paymentMethod' must be 'manual' or 'paypal'" },
          { status: 400 }
        );
      }
      paymentMethod = body.paymentMethod;
    }

    if (!metaPricing && !paymentMethod) {
      return NextResponse.json(
        { error: "nothing to change: send 'metaPricing' or 'paymentMethod'" },
        { status: 400 }
      );
    }

    const account = await loadAccountSummary(id);
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const outcome = await updateManagedPricing({
      accountId: id,
      accountName: account.name,
      actorUserId: ctx.userId,
      reason,
      metaPricing,
      paymentMethod,
    });

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not_managed':
          return NextResponse.json(
            {
              error:
                'Cabbity does not pay Meta for this company; assign it the managed plan first',
              code: 'not_managed',
            },
            { status: 409 }
          );
        case 'paypal_active':
          return NextResponse.json(
            {
              error:
                'PayPal is still billing the fee of this company. Cancel it at PayPal first; nothing was changed.',
              code: 'paypal_active',
            },
            { status: 409 }
          );
        case 'needs_checkout':
          return NextResponse.json(
            {
              error:
                'There is no live PayPal subscription to charge the fee. Assign the plan with PayPal from the file instead.',
              code: 'needs_checkout',
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
      changed: outcome.changed,
      metaPricing: outcome.metaPricing,
      paymentMethod: outcome.paymentMethod,
    });
  } catch (err) {
    console.error(
      '[PATCH /api/platform/accounts/[id]/meta-pricing] failed:',
      err
    );
    return NextResponse.json(
      { error: 'Failed to change the Meta price' },
      { status: 500 }
    );
  }
}
