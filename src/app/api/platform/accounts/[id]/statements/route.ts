// ============================================================
// GET /api/platform/accounts/[id]/statements — the statements of one
// company on the operator's file (fase 10, s10.4), with the internal
// figures: real cost at Meta, margin, the `billable` breakdown, the
// payment reference and the customer's «Ya pagué» note.
//
// Platform operators only (`requirePlatformAdmin()`); a company owner
// gets 403 even on his own company. Filtered by the account of the URL.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { loadAccountSummary } from '@/lib/platform/accounts';
import { listAccountStatements } from '@/lib/platform/statements';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    throw err;
  }

  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const account = await loadAccountSummary(id);
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const statements = await listAccountStatements(id);
    return NextResponse.json({ accountId: id, statements });
  } catch (err) {
    console.error('[GET /api/platform/accounts/[id]/statements] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the statements' },
      { status: 500 }
    );
  }
}
