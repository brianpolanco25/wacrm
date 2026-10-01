// ============================================================
// POST /api/platform/rates/import — CSV import of Meta's rate card
// (fase 10, s10.2).
//
// Body: `{ csv: string, dryRun?: boolean }`. The text is
// `market,category,usd_per_message,effective_from`, one rate per line,
// header optional. Every line is classified (`new`, `exists`,
// `conflict`, `retroactive`, `invalid`, `duplicate`) and the preview is
// returned as is:
//
//   dryRun: true   200 with the preview, nothing written.
//   dryRun: false  201 and inserts the `new` rows — all at once — only
//                  when nothing blocks; otherwise 400 with the preview.
//
// `requirePlatformAdmin()` first; service role for the insert.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { importRates, RateRefusedError } from '@/lib/platform/rates';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/** A full rate card is a few hundred lines; this is far above it. */
const CSV_MAX_CHARS = 200_000;

function isAuthError(err: unknown): boolean {
  return err instanceof UnauthorizedError || err instanceof ForbiddenError;
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

    const body = (await request.json().catch(() => null)) as {
      csv?: unknown;
      dryRun?: unknown;
    } | null;
    if (
      !body ||
      typeof body.csv !== 'string' ||
      (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')
    ) {
      return NextResponse.json(
        { error: 'body must be { csv: string, dryRun?: boolean }' },
        { status: 400 }
      );
    }
    if (body.csv.length > CSV_MAX_CHARS) {
      return NextResponse.json(
        { error: `the CSV is longer than ${CSV_MAX_CHARS} characters` },
        { status: 400 }
      );
    }

    const dryRun = body.dryRun === true;
    const result = await importRates(body.csv, ctx.userId, dryRun);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const { preview, inserted } = result.value;
    if (dryRun) return NextResponse.json({ preview, inserted: 0 });
    if (!preview.importable) {
      return NextResponse.json(
        { error: 'Some lines block the import', preview, inserted: 0 },
        { status: 400 }
      );
    }
    return NextResponse.json({ preview, inserted }, { status: 201 });
  } catch (err) {
    if (err instanceof RateRefusedError) {
      return NextResponse.json(
        { error: err.message, reason: err.status },
        { status: 409 }
      );
    }
    console.error('[POST /api/platform/rates/import] failed:', err);
    return NextResponse.json(
      { error: 'Failed to import the rates' },
      { status: 500 }
    );
  }
}
