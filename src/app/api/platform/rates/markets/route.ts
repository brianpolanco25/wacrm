// ============================================================
// /api/platform/rates/markets — country → Meta market table
// (`meta_market_countries`, 076; fase 10, s10.2).
//
//   GET  every mapped country.
//   PUT  `{ entries: [{ country_code, market | null }] }`: upsert the
//        entries with a market, remove the ones set to null (that
//        country then falls back to `rest_of_world`). Answers the whole
//        table.
//
// `requirePlatformAdmin()` first; the table is global and only the
// service role writes it.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { validateMarketEntries } from '@/lib/billing/meta-rate-input';
import { applyMarketEntries, listMarketCountries } from '@/lib/platform/rates';
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
    return NextResponse.json({ markets: await listMarketCountries() });
  } catch (err) {
    if (isAuthError(err)) return toErrorResponse(err);
    console.error('[GET /api/platform/rates/markets] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the markets' },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
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
    const input = validateMarketEntries(body);
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: 400 });
    }
    const markets = await applyMarketEntries(input.value);
    return NextResponse.json({ markets });
  } catch (err) {
    console.error('[PUT /api/platform/rates/markets] failed:', err);
    return NextResponse.json(
      { error: 'Failed to save the markets' },
      { status: 500 }
    );
  }
}
