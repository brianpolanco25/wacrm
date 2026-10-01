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
// Billing emails (fase 11, p11.7): right after the statements, the same
// run sends the optional emails — 80 % / 100 % of a direct number's free
// service quota, a statement issued or overdue — if an email provider is
// configured (`src/lib/email/provider.ts`). Each sweep has its own `try`:
// an email failure never touches the statements block nor its status
// code, and a statement failure does not stop the emails. Without a
// provider the email sweep makes no query and answers
// `emails.enabled = false`.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { resolveLocale } from '@/i18n/request';
import {
  sweepBillingEmails,
  type BillingEmailSweep,
} from '@/lib/billing/billing-emails';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  sweepStatements,
  type StatementSweep,
} from '@/lib/billing/statement-cron';

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

  const admin = supabaseAdmin();

  let statements: StatementSweep | null = null;
  let statementsError: unknown = null;
  try {
    statements = await sweepStatements(admin);
  } catch (err) {
    // Only the listing itself can land here (one account's failure is in
    // the summary). Nothing was issued by this run.
    statementsError = err;
  }

  let emails: BillingEmailSweep;
  try {
    emails = await sweepBillingEmails(admin, {
      locale: resolveLocale(process.env.NEXT_PUBLIC_APP_LOCALE),
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? null,
    });
  } catch (err) {
    // `sweepBillingEmails` never throws; this is the belt to its braces.
    console.error(
      '[GET /api/billing/cron] email sweep failed:',
      err instanceof Error ? err.message : err
    );
    emails = {
      enabled: false,
      accounts: 0,
      truncated: false,
      sent: 0,
      failed: 0,
      skipped: 0,
      errors: 1,
    };
  }

  if (statementsError) {
    console.error('[GET /api/billing/cron] sweep failed:', statementsError);
    return NextResponse.json(
      { error: 'The statement sweep failed', emails },
      { status: 500 }
    );
  }
  return NextResponse.json({ statements, emails });
}
