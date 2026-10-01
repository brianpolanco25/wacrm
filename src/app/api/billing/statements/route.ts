// ============================================================
// GET /api/billing/statements — the customer's statements (fase 10,
// s10.4, «Estados de cuenta» on /billing).
//
// `admin+`, like the rest of the money of `/api/billing/*`, and
// reachable while the account is read-only (`allowReadOnly`): seeing
// what is owed is the way out of the lock.
//
// Read with the service role and filtered by the caller's account by
// hand, then reduced to what the customer is shown
// (`customerStatement`): number, category, delivered, price applied,
// amount and total. Never the `billable` mark, Meta's rate, the real
// cost or the payment reference — those are the operator's.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  CUSTOMER_STATEMENT_COLUMNS,
  customerStatement,
  type StatementRow,
} from '@/lib/billing/statements';

/** Statements shown, newest first: two years of months. */
const LIMIT = 24;

export async function GET() {
  try {
    const ctx = await requireRole('admin', { allowReadOnly: true });

    const { data, error } = await supabaseAdmin()
      .from('statements')
      .select(CUSTOMER_STATEMENT_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('period_end', { ascending: false })
      .limit(LIMIT);
    if (error) {
      console.error('[GET /api/billing/statements] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load the statements' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      statements: ((data ?? []) as unknown as StatementRow[]).map(
        customerStatement
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
