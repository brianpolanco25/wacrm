// ============================================================
// GET /api/platform/accounts/[id]/statements — the statements of one
// company on the operator's file (fase 10, s10.4), with the internal
// figures: real cost at Meta, margin, the `billable` breakdown, the
// payment reference and the customer's «Ya pagué» note.
//
// Platform operators only (`requirePlatformAdmin()`); a company owner
// gets 403 even on his own company. Filtered by the account of the URL.
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
import { listAccountStatements } from '@/lib/platform/statements';

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
