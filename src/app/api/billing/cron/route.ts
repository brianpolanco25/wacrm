// ============================================================
// GET /api/billing/cron — the cut-off of managed Meta billing
// (fase 10, s10.4): issues the statement of every managed account whose
// period ended, and puts it on its three days of grace.
//
// Same pattern as `/api/webhooks/cron`: a shared secret in
// `x-cron-secret`, compared in constant time, for an external scheduler
// (Vercel Cron, a pinger, `curl` in a systemd timer). Without
// `BILLING_CRON_SECRET` the route answers 503 instead of staying open.
//
// Idempotent: a statement per account and cut-off (UNIQUE, migration
// 078), so running it three times the same day issues one. One account
// that cannot be billed (a Meta rate missing) is skipped with its error
// in the summary; the others go on.
//
// CP11: nothing here touches inbound messages.
//
// s10.7: after the cut-off, one more sweep downloads Meta's
// `pricing_analytics` of each managed WABA (`meta-reconciliation.ts`);
// its counts travel in the `reconciliation` block of the response.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sweepStatements } from '@/lib/billing/statement-cron';
import { sweepMetaReconciliation } from '@/lib/billing/meta-reconciliation';

function secretMatches(supplied: string, expected: string): boolean {
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(suppliedBuf, expectedBuf);
}

export async function GET(request: Request) {
  const expected = process.env.BILLING_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }

  const supplied = request.headers.get('x-cron-secret') ?? '';
  if (!secretMatches(supplied, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const statements = await sweepStatements(supabaseAdmin());
    // s10.7: Meta's own figures for the reconciliation, at most once a
    // day per account. Never throws: a failure is counted, not raised.
    const reconciliation = await sweepMetaReconciliation(supabaseAdmin());
    return NextResponse.json({ statements, reconciliation });
  } catch (err) {
    // Only the listing itself can land here (one account's failure is in
    // the summary). Nothing was issued by this run.
    console.error('[GET /api/billing/cron] sweep failed:', err);
    return NextResponse.json(
      { error: 'The statement sweep failed' },
      { status: 500 }
    );
  }
}
