// ============================================================
// GET /api/platform/accounts/[id]/support-actions — the support sessions
// opened on one account and what was changed in each (s9.5).
//
// The id arrives in the URL and is therefore attacker controlled.
// `requirePlatformAdmin()` is what makes reading another company's trail
// legitimate at all; every query behind it is filtered by THIS id (see
// `src/lib/platform/support-activity.ts`). An account that does not exist
// is a 404 with nothing else in the body.
// ============================================================

import { UUID_RE } from '@/lib/uuid';
import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { loadAccountSummary } from '@/lib/platform/accounts';
import { loadSupportActivity } from '@/lib/platform/support-activity';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requirePlatformAdmin();

    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (!(await loadAccountSummary(id))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json(await loadSupportActivity(id), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    console.error('[GET /api/platform/accounts/[id]/support-actions]:', err);
    return NextResponse.json(
      { error: 'Failed to load the support sessions' },
      { status: 500 }
    );
  }
}
