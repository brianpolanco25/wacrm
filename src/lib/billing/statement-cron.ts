// ============================================================
// The cut-off sweep of managed Meta billing (fase 10, s10.4), run by
// `GET /api/billing/cron`.
//
// For every subscription with `meta_billing = 'managed'` whose
// `current_period_end` has passed:
//
//   1. If a statement for that `period_end` already exists, nothing new
//      is issued (UNIQUE (account_id, period_end), migration 078). An
//      `issued` one only gets its lock re-applied in case the previous
//      run died between the two writes — so the sweep is idempotent AND
//      self-healing: three runs on the same day issue one statement.
//   2. Otherwise the statement is built (`computeStatement`) over the
//      period that ends at `current_period_end`:
//        - total 0 (PayPal with no overage: the fee is PayPal's): no
//          statement and no cut-off — the period is extended a month;
//        - otherwise it is issued (`issued`, `due_at = period_end + 3
//          days`) and the subscription goes `past_due` with
//          `grace_until = due_at`. `current_period_end` is NOT touched:
//          the next period starts where this one ended, whenever it is
//          paid (no drift). Settling the statement moves it.
//   3. A statement that cannot be built (a Meta rate missing — the s10.2
//      contract —, no valid price policy, a database error) skips THAT
//      account, with the error in the summary, and the sweep goes on.
//
// After the three days nothing else happens here: `isReadOnly()` (and
// the open statement in `getEntitlements()`) already make the account
// read-only. CP11: nothing in this file touches what comes in.
//
// The sweep runs across accounts on purpose (the service role, one
// listing with no account filter); every write after it is filtered by
// the `account_id` of the row being processed.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { addCycle } from './webhook-events';
import {
  loadRateCard,
  MetaRateMissingError,
  type RateCard,
} from './meta-rates';
import {
  computeStatement,
  effectivePaymentMethod,
  statementDueAt,
  statementPeriodStart,
  StatementPricingError,
} from './statements';

/** Managed accounts handled per sweep; the rest wait for the next one. */
export const STATEMENT_SWEEP_LIMIT = 200;

interface DueSubscription {
  account_id: string;
  status: string;
  provider: string | null;
  payment_method: string | null;
  meta_pricing: unknown;
  current_period_end: string;
  grace_until: string | null;
}

export interface StatementSweepError {
  accountId: string;
  periodEnd: string;
  kind: 'rate_missing' | 'pricing' | 'database';
  error: string;
}

export interface StatementSweep {
  scanned: number;
  issued: number;
  /** Already had its statement for that cut-off (idempotent re-run). */
  existing: number;
  /** Nothing to bill (PayPal, no overage): period extended, no cut-off. */
  extended: number;
  failed: number;
  errors: StatementSweepError[];
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

/**
 * The lock of an issued statement: `past_due` until `due_at`. A
 * subscription in a worse state (suspended, cancelled, expired) is left
 * as it is, and an earlier grace (a PayPal payment that failed first)
 * is never pushed later.
 */
export function lockPatch(
  sub: { status: string; grace_until: string | null },
  dueAt: string
): { status?: string; grace_until?: string } | null {
  if (sub.status === 'active') {
    return { status: 'past_due', grace_until: dueAt };
  }
  if (sub.status === 'past_due') {
    if (sub.grace_until && Date.parse(sub.grace_until) <= Date.parse(dueAt)) {
      return null;
    }
    return { grace_until: dueAt };
  }
  return null;
}

async function applyLock(
  client: SupabaseClient,
  sub: DueSubscription,
  dueAt: string
): Promise<void> {
  const patch = lockPatch(sub, dueAt);
  if (!patch) return;
  const { error } = await client
    .from('subscriptions')
    .update(patch)
    .eq('account_id', sub.account_id);
  if (error) throw error;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

async function processOne(
  client: SupabaseClient,
  sub: DueSubscription,
  rateCard: RateCard,
  summary: StatementSweep
): Promise<void> {
  const accountId = sub.account_id;
  const periodEnd = iso(sub.current_period_end);

  const { data: existing, error: existingErr } = await client
    .from('statements')
    .select('id, status, due_at')
    .eq('account_id', accountId)
    .eq('period_end', periodEnd)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing) {
    summary.existing += 1;
    const row = existing as { status: string; due_at: string };
    if (row.status === 'issued') await applyLock(client, sub, row.due_at);
    return;
  }

  const { data: previous, error: previousErr } = await client
    .from('statements')
    .select('period_end')
    .eq('account_id', accountId)
    .lt('period_end', periodEnd)
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previousErr) throw previousErr;

  const periodStart = statementPeriodStart(
    periodEnd,
    (previous as { period_end: string } | null)?.period_end ?? null
  );
  const paymentMethod = effectivePaymentMethod(
    sub.payment_method,
    sub.provider
  );

  const built = await computeStatement(client, {
    accountId,
    periodStart,
    periodEnd,
    metaPricing: sub.meta_pricing,
    paymentMethod,
    rateCard,
  });

  if (built.total_usd === 0) {
    // Nothing to collect (PayPal charges the fee, no overage): no
    // statement and no cut-off. The period moves on a month, from the
    // cut-off, exactly as a settled statement would move it. Filtered
    // by the end we read, so a concurrent sweep cannot extend it twice.
    const { error } = await client
      .from('subscriptions')
      .update({ current_period_end: addCycle(periodEnd, 'month') })
      .eq('account_id', accountId)
      .eq('current_period_end', sub.current_period_end);
    if (error) throw error;
    summary.extended += 1;
    return;
  }

  const dueAt = statementDueAt(periodEnd);
  const { data: inserted, error: insertErr } = await client
    .from('statements')
    .upsert(
      {
        ...built,
        status: 'issued',
        issued_at: new Date().toISOString(),
        due_at: dueAt,
      },
      { onConflict: 'account_id,period_end', ignoreDuplicates: true }
    )
    .select('id, due_at');
  if (insertErr) throw insertErr;

  const rows = (inserted ?? []) as { id: string; due_at: string }[];
  if (rows.length > 0) summary.issued += 1;
  else summary.existing += 1; // a concurrent sweep won the UNIQUE
  await applyLock(client, sub, dueAt);
}

/** One sweep. Never throws for one account: its error goes in `errors`. */
export async function sweepStatements(
  client: SupabaseClient,
  now: Date = new Date()
): Promise<StatementSweep> {
  const summary: StatementSweep = {
    scanned: 0,
    issued: 0,
    existing: 0,
    extended: 0,
    failed: 0,
    errors: [],
  };

  // Cross-account on purpose: the sweep. Every write below is scoped by
  // the account of the row.
  const { data, error } = await client
    .from('subscriptions')
    .select(
      'account_id, status, provider, payment_method, meta_pricing, current_period_end, grace_until'
    )
    .eq('meta_billing', 'managed')
    .not('current_period_end', 'is', null)
    .lte('current_period_end', now.toISOString())
    .order('current_period_end', { ascending: true })
    .limit(STATEMENT_SWEEP_LIMIT);
  if (error) throw error;

  // `incomplete`: PayPal has not activated it yet, nothing was served.
  const due = ((data ?? []) as DueSubscription[]).filter(
    (s) => s.status !== 'incomplete'
  );
  summary.scanned = due.length;
  if (due.length === 0) return summary;

  const rateCard = await loadRateCard(client);

  for (const sub of due) {
    try {
      await processOne(client, sub, rateCard, summary);
    } catch (err) {
      const kind =
        err instanceof MetaRateMissingError
          ? 'rate_missing'
          : err instanceof StatementPricingError
            ? 'pricing'
            : 'database';
      const entry: StatementSweepError = {
        accountId: sub.account_id,
        periodEnd: iso(sub.current_period_end),
        kind,
        error: describe(err),
      };
      summary.failed += 1;
      summary.errors.push(entry);
      console.error('[billing/statement-cron] account skipped:', entry);
    }
  }
  return summary;
}
