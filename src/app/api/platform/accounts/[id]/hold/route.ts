// ============================================================
// POST /api/platform/accounts/[id]/hold — suspend or reactivate an
// account by hand (fase 4 §2, «Suspender y reactivar»).
//
// Body: `{ action: 'suspend' | 'reactivate', reason }`.
//
// WHAT THIS WRITES, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------
// It writes `subscriptions.manual_hold_*` and nothing else. It does NOT
// touch `status`, and that is the whole design:
//
//   - `status` belongs to the PayPal webhook of fase 3. A suspension
//     written there would be lifted by the next `ACTIVATED` event — the
//     spec asks for the opposite, that a gateway reactivation must NOT
//     lift an operator's hold.
//   - the hold is a separate axis, so both can be true at once: an
//     account can be `active` at PayPal and still held here, and paying
//     the bill does not change that.
//
// The permission layer of f3.4 honours it without any change of its
// own: `getEntitlements()` reads `manual_hold_at` off the subscription
// row it was already fetching and folds it into `readOnly`, so
// `requireRole('agent' | 'admin' | 'owner')` refuses. Reads keep
// working, and so does the WhatsApp webhook — CP11 is not negotiable
// and has its own test.
//
// EVERY CALL IS AUDITED, AND THE AUDIT COMES FIRST
// ------------------------------------------------
// The bitácora row is written BEFORE the hold, same rule as f4.4's
// impersonation: if it cannot be recorded, nothing happens. A silent
// suspension is the same back door the spec refuses for impersonation.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAccountSummary, setManualHold } from '@/lib/platform/accounts';
import { MIN_REASON_LENGTH, recordPlatformAction } from '@/lib/platform/audit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type HoldAction = 'suspend' | 'reactivate';

function isHoldAction(value: unknown): value is HoldAction {
  return value === 'suspend' || value === 'reactivate';
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
      `platform:hold:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      reason?: unknown;
    } | null;

    if (!isHoldAction(body?.action)) {
      return NextResponse.json(
        { error: "'action' must be 'suspend' or 'reactivate'" },
        { status: 400 }
      );
    }

    // Same minimum as the impersonation reason, and the same purpose:
    // it is the column that makes the trail worth keeping. Enforced in
    // the database too (058), so a shorter one here would be a 500.
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

    const recorded = await recordPlatformAction({
      action: body.action,
      actorUserId: ctx.userId,
      accountId: id,
      accountName: account.name,
      reason,
    });
    if (!recorded) {
      return NextResponse.json(
        { error: 'Could not record the action; nothing was changed' },
        { status: 500 }
      );
    }

    const applied = await setManualHold({
      accountId: id,
      hold: body.action === 'suspend',
      actorUserId: ctx.userId,
      reason,
    });

    if (!applied) {
      // No `subscriptions` row. Migration 046 seeds one on signup and
      // its trigger swallows its own failures, so this is rare and
      // worth naming rather than reporting as success.
      return NextResponse.json(
        {
          error:
            'This account has no subscription row, so there is nothing to hold',
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      accountId: id,
      manualHold: body.action === 'suspend',
    });
  } catch (err) {
    console.error('[POST /api/platform/accounts/[id]/hold] failed:', err);
    return NextResponse.json(
      { error: 'Failed to change the account hold' },
      { status: 500 }
    );
  }
}
