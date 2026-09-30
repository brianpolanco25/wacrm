// ============================================================
// GET /api/platform/plan-options — the plans an operator may assign by
// hand (s9.4): every row of the catalogue, public or not.
//
// Its own tiny route, not `/api/platform/plans`, which belongs to the
// plan administration of s9.3 (edit, publish, sync with PayPal). This
// one only feeds the plan selectors of «Nueva empresa» and the file.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { listPlanOptions } from '@/lib/platform/provisioning';

export async function GET() {
  try {
    await requirePlatformAdmin();
    return NextResponse.json({ plans: await listPlanOptions() });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    console.error('[GET /api/platform/plan-options] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the plans' },
      { status: 500 }
    );
  }
}
