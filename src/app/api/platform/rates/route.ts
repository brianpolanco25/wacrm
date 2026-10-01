// ============================================================
// /api/platform/rates — Meta's rate card from the operator's panel
// (fase 10, s10.2).
//
//   GET   every rate, newest first per market and category, with which
//         one is in force today and which are scheduled.
//   POST  add ONE rate with its `effective_from`. A rate in force is
//         never edited: the same key (409), or a past date that would
//         re-price messages already delivered (409), is refused.
//
// Both start with `requirePlatformAdmin()`: owning a company buys
// nothing here (403). Writes use the service role: `meta_rates` has no
// write policy (076). The table is global (no account_id).
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { validateRateInput } from '@/lib/billing/meta-rate-input';
import {
  insertRate,
  listRates,
  RateRefusedError,
  todayUtc,
} from '@/lib/platform/rates';
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
    const rates = await listRates();
    return NextResponse.json({ today: todayUtc(), rates });
  } catch (err) {
    if (isAuthError(err)) return toErrorResponse(err);
    console.error('[GET /api/platform/rates] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the rates' },
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
      `platform:rates:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const input = validateRateInput(body);
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: 400 });
    }

    const rate = await insertRate(input.value, ctx.userId);
    return NextResponse.json({ rate }, { status: 201 });
  } catch (err) {
    if (err instanceof RateRefusedError) {
      return NextResponse.json(
        { error: err.message, reason: err.status },
        { status: 409 }
      );
    }
    console.error('[POST /api/platform/rates] failed:', err);
    return NextResponse.json(
      { error: 'Failed to add the rate' },
      { status: 500 }
    );
  }
}
