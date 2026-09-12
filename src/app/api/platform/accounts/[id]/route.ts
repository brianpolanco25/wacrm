// ============================================================
// GET /api/platform/accounts/[id] — one account's file (fase 4 §2,
// «Ficha de cuenta»).
//
// Consumption per metric against the plan's caps, the billing history
// from the gateway log, the members, and the state of the WhatsApp
// connection — every number of it, since f4.2 made the relation
// one-to-many and a single "connected: yes/no" would lie about at least
// one of them.
//
// Tenancy: the id arrives in the URL and is therefore attacker
// controlled. `requirePlatformAdmin()` is what makes reading another
// company's file legitimate at all; every query behind it is filtered
// by THIS id and nothing else (see the header of
// `src/lib/platform/accounts.ts`). An account that does not exist is a
// 404 with nothing else in the body.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { loadAccountDetail } from '@/lib/platform/accounts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

    const detail = await loadAccountDetail(id);
    if (!detail) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    console.error('[GET /api/platform/accounts/[id]] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the account' },
      { status: 500 }
    );
  }
}
