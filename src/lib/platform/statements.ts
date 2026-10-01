// ============================================================
// Statements on the operator's file of a company (fase 10, s10.4,
// «Estados de cuenta»): the list with the internal figures (real cost
// at Meta, margin, the `billable` breakdown), and the two acts on an
// open statement.
//
//   confirmPayment  → `paid` (date, reference, note: the payment is the
//                     reason, so none is asked for).
//   voidStatement   → `void` (reason of at least MIN_REASON_LENGTH).
//
// Both settle the subscription the same way: the cut-off moves one month
// from the `period_end` of the statement — never from the day it was
// paid, so paying late does not move the billing day — and the lock of
// the statement is lifted (`active`, `grace_until = NULL`), unless
// another statement is still open, whose due date then becomes the
// grace. A `past_due` that came from PayPal (a failed charge, with an
// earlier grace) is not this statement's to lift.
//
// Order, as in s9.4: the bitácora row (`payment_confirmed` /
// `statement_void`) is written BEFORE anything changes, and nothing
// changes if it cannot be written. Then the subscription, then the
// statement (conditional on it still being `issued`): if the last write
// fails the operator retries, and the subscription step is idempotent.
//
// Service role, every query filtered by `account_id` by hand.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';
import {
  nextPeriodEnd,
  type StatementLine,
  type StatementRow,
  type StatementUsage,
} from '@/lib/billing/statements';
import { recordPlatformAction } from './audit';

export interface PlatformStatement {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  paidBy: string | null;
  paidReference: string | null;
  paidNote: string | null;
  claimedPaidAt: string | null;
  claimNote: string | null;
  planFeeUsd: number;
  usageChargeUsd: number;
  totalUsd: number;
  metaCostUsd: number;
  /** What Cabbity keeps: total − real cost at Meta. */
  marginUsd: number;
  includedMessages: number;
  messagesTotal: number;
  overageMessages: number;
  uncategorized: { total: number; byCategory: Record<string, number> };
  lines: StatementLine[];
}

/** Statements shown on the file, newest first. */
export const STATEMENT_LIST_LIMIT = 24;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function platformStatement(row: StatementRow): PlatformStatement {
  const usage = (
    row.usage && typeof row.usage === 'object' ? row.usage : {}
  ) as Partial<StatementUsage>;
  const total = num(row.total_usd);
  const metaCost = num(row.meta_cost_usd);
  return {
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    paidAt: row.paid_at ?? null,
    paidBy: row.paid_by ?? null,
    paidReference: row.paid_reference ?? null,
    paidNote: row.paid_note ?? null,
    claimedPaidAt: row.claimed_paid_at ?? null,
    claimNote: row.claim_note ?? null,
    planFeeUsd: num(row.plan_fee_usd),
    usageChargeUsd: num(row.usage_charge_usd),
    totalUsd: total,
    metaCostUsd: metaCost,
    marginUsd: round2(total - metaCost),
    includedMessages: num(row.included_messages),
    messagesTotal: num(row.messages_total),
    overageMessages: num(row.overage_messages),
    uncategorized: {
      total: num(usage.uncategorized?.total),
      byCategory: { ...(usage.uncategorized?.by_category ?? {}) },
    },
    lines: Array.isArray(usage.lines) ? usage.lines : [],
  };
}

export async function listAccountStatements(
  accountId: string
): Promise<PlatformStatement[]> {
  const { data, error } = await supabaseAdmin()
    .from('statements')
    .select('*')
    .eq('account_id', accountId)
    .order('period_end', { ascending: false })
    .limit(STATEMENT_LIST_LIMIT);
  if (error) throw error;
  return ((data ?? []) as StatementRow[]).map(platformStatement);
}

interface SubscriptionState {
  status: string;
  grace_until: string | null;
  current_period_end: string | null;
}

/**
 * What settling `statement` does to the subscription. Pure, for the
 * tests. `nextOpenDueAt` is the due date of another statement still
 * open, if any.
 */
export function settlePatch(
  sub: SubscriptionState,
  statement: { period_end: string; due_at: string },
  nextOpenDueAt: string | null
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    current_period_end: nextPeriodEnd(
      statement.period_end,
      sub.current_period_end
    ),
  };
  if (sub.status !== 'past_due') return patch;
  // Our lock: no grace, or the one the cut-off set (never pushed later
  // than a PayPal grace that came first — see `lockPatch`).
  const ours =
    !sub.grace_until ||
    Date.parse(sub.grace_until) >= Date.parse(statement.due_at);
  if (!ours) return patch;
  if (nextOpenDueAt) {
    patch.grace_until = nextOpenDueAt;
  } else {
    patch.status = 'active';
    patch.grace_until = null;
  }
  return patch;
}

export type SettleOutcome =
  | {
      ok: true;
      statement: PlatformStatement;
      currentPeriodEnd: string;
      subscriptionStatus: string;
    }
  | { ok: false; reason: 'not_found' | 'not_open' | 'audit_failed' };

export type SettleRequest =
  | {
      kind: 'confirm';
      paidAt: string;
      reference: string | null;
      note: string | null;
    }
  | { kind: 'void'; reason: string };

function usd(value: unknown): string {
  return num(value).toFixed(2);
}

function day(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export async function settleStatement(args: {
  accountId: string;
  accountName: string | null;
  statementId: string;
  actorUserId: string;
  request: SettleRequest;
}): Promise<SettleOutcome> {
  const db = supabaseAdmin();
  const { accountId, statementId, request } = args;

  const { data: found, error: foundErr } = await db
    .from('statements')
    .select('*')
    .eq('id', statementId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (foundErr) throw foundErr;
  if (!found) return { ok: false, reason: 'not_found' };
  const statement = found as StatementRow;
  if (statement.status !== 'issued') return { ok: false, reason: 'not_open' };

  const { data: subRow, error: subErr } = await db
    .from('subscriptions')
    .select('status, grace_until, current_period_end')
    .eq('account_id', accountId)
    .maybeSingle();
  if (subErr) throw subErr;
  const sub = (subRow as SubscriptionState | null) ?? null;

  const { data: others, error: othersErr } = await db
    .from('statements')
    .select('id, due_at')
    .eq('account_id', accountId)
    .eq('status', 'issued')
    .neq('id', statementId)
    .order('due_at', { ascending: true })
    .limit(1);
  if (othersErr) throw othersErr;
  const nextOpen =
    ((others ?? []) as { id: string; due_at: string }[])[0]?.due_at ?? null;

  const patch = sub ? settlePatch(sub, statement, nextOpen) : null;
  const period = `${day(statement.period_start)} → ${day(statement.period_end)}`;

  // The bitácora, BEFORE the act. `payment_confirmed` takes no reason
  // from the operator (the payment is the reason), but the column has a
  // CHECK of ten characters (055), so it says what was paid.
  const logId = await recordPlatformAction({
    action: request.kind === 'confirm' ? 'payment_confirmed' : 'statement_void',
    actorUserId: args.actorUserId,
    accountId,
    accountName: args.accountName,
    reason:
      request.kind === 'confirm'
        ? `payment confirmed: statement ${period}, US$ ${usd(statement.total_usd)}` +
          (request.reference ? `, ref. ${request.reference}` : '')
        : request.reason,
    details: {
      statement_id: statement.id,
      period_start: statement.period_start,
      period_end: statement.period_end,
      total_usd: num(statement.total_usd),
      ...(request.kind === 'confirm'
        ? {
            paid_at: request.paidAt,
            paid_reference: request.reference,
            paid_note: request.note,
          }
        : {}),
      from_status: sub?.status ?? null,
      from_period_end: sub?.current_period_end ?? null,
      to_period_end: (patch?.current_period_end as string | undefined) ?? null,
    },
  });
  if (!logId) return { ok: false, reason: 'audit_failed' };

  if (patch) {
    const { error } = await db
      .from('subscriptions')
      .update(patch)
      .eq('account_id', accountId);
    if (error) throw error;
  }

  const settled =
    request.kind === 'confirm'
      ? {
          status: 'paid',
          paid_at: request.paidAt,
          paid_by: args.actorUserId,
          paid_reference: request.reference,
          paid_note: request.note,
        }
      : { status: 'void' };
  const { data: updated, error: updErr } = await db
    .from('statements')
    .update(settled)
    .eq('id', statementId)
    .eq('account_id', accountId)
    .eq('status', 'issued')
    .select('*');
  if (updErr) throw updErr;
  const rows = (updated ?? []) as StatementRow[];
  // Another operator settled it between our read and this write. The
  // subscription step was the same for both, so nothing is out of step.
  if (rows.length === 0) return { ok: false, reason: 'not_open' };

  return {
    ok: true,
    statement: platformStatement(rows[0]),
    currentPeriodEnd:
      (patch?.current_period_end as string | undefined) ??
      sub?.current_period_end ??
      '',
    subscriptionStatus:
      (patch?.status as string | undefined) ?? sub?.status ?? '',
  };
}
