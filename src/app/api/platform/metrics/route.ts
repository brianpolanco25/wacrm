// ============================================================
// GET /api/platform/metrics — the operator's Resumen (s9.2).
//
// Accounts by subscription state, signups, MRR/ARR, comped, delinquent,
// connected WhatsApp numbers and the month's messages, from
// `platform_metrics()` (migration 069) in a single round trip.
//
// `requirePlatformAdmin()` first, as on every route of this prefix: a
// company `owner` gets the same bare 403 as anybody else, and the
// function is never called for them.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { loadPlatformMetrics } from '@/lib/platform/metrics';

export async function GET() {
  try {
    await requirePlatformAdmin();
    return NextResponse.json(await loadPlatformMetrics(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    console.error('[GET /api/platform/metrics] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the platform metrics' },
      { status: 500 }
    );
  }
}
