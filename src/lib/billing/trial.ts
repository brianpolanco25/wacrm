// ============================================================
// How much of the trial is left, and whether that is worth saying.
//
// Pure on purpose: the header banner (p6.2 §2) renders whatever this
// returns, so the arithmetic — which is the only part that can be wrong
// — is testable without React, a clock or a catalogue.
//
// Two rules the spec fixes and this encodes:
//
//   * Only `trialing` says anything. Once the account leaves that state
//     — it contracted, or the trial expired and the dunning ladder of
//     fase 3 took over — the banner disappears. `BillingStatusAlert`
//     owns every other rung, and two notices about the same thing is
//     one too many.
//   * Below a full day left the number stops being useful ("in 0 days"
//     is not a sentence), so it collapses to "today". An already-expired
//     `trial_ends_at` on a row still marked `trialing` — the window
//     between the deadline and the job that processes it — says the same
//     thing: today is the last day.
// ============================================================

/** Milliseconds in a day. Trials are measured in whole days. */
const DAY_MS = 86_400_000;

export type TrialNotice =
  /** More than a full day left; `days` whole days remain. */
  | { kind: 'days'; days: number }
  /** Less than a full day left, or the deadline already passed. */
  | { kind: 'today' };

/**
 * What the banner should say, or `null` for "say nothing".
 *
 * `null` covers every case where a number would be a claim we cannot
 * back: any status other than `trialing`, a missing `trial_ends_at`
 * (the column is nullable — a trial row without a deadline exists in
 * principle and we will not invent one), and an unparseable date.
 *
 * @param status       `subscriptions.status`, as served by `/api/billing/status`.
 * @param trialEndsAt  ISO timestamp, or null.
 * @param now          Epoch ms. Injected so tests don't race the clock.
 */
export function trialNotice(
  status: string | null | undefined,
  trialEndsAt: string | null | undefined,
  now: number
): TrialNotice | null {
  if (status !== 'trialing') return null;
  if (!trialEndsAt) return null;

  const endsAt = Date.parse(trialEndsAt);
  if (Number.isNaN(endsAt)) return null;

  const remaining = endsAt - now;
  // Under a full day — including an already-passed deadline — there is
  // no number worth printing.
  if (remaining < DAY_MS) return { kind: 'today' };

  // Whole days, rounded UP, which is how people count days left: a
  // 14-day trial reads "14 days" the moment it starts, not "13" because
  // a few milliseconds went by between the INSERT and the render. The
  // error it can make is at most a few hours of optimism in the middle
  // of the trial; rounding down would instead be wrong by a whole day
  // at the only two moments anybody checks — the first and the last.
  return { kind: 'days', days: Math.ceil(remaining / DAY_MS) };
}
