// ============================================================
// «Ya pagué» (s10.4): tell Cabbity a statement was paid. Leaves a note
// on the operator's file and changes nothing else — the account stays
// as it is until an operator confirms the payment.
//
// Pure of React so the banner and /billing share it, and the tests can
// drive it with a fake fetch.
// ============================================================

export type ClaimOutcome =
  | { kind: 'claimed'; claimedPaidAt: string | null }
  | { kind: 'error'; reason: 'notOpen' | 'forbidden' | 'failed' };

export async function claimStatementPaid(
  statementId: string,
  note: string | null = null,
  doFetch: typeof fetch = fetch
): Promise<ClaimOutcome> {
  try {
    const res = await doFetch(
      `/api/billing/statements/${statementId}/claim-paid`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(note ? { note } : {}),
      }
    );
    const json = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (res.ok) {
      return {
        kind: 'claimed',
        claimedPaidAt:
          typeof json?.claimedPaidAt === 'string' ? json.claimedPaidAt : null,
      };
    }
    if (res.status === 409) return { kind: 'error', reason: 'notOpen' };
    if (res.status === 403) return { kind: 'error', reason: 'forbidden' };
    return { kind: 'error', reason: 'failed' };
  } catch {
    return { kind: 'error', reason: 'failed' };
  }
}

/** Whole days left until `dueAt`, counted from `at` (never negative). */
export function daysLeft(dueAt: string, at: number): number {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return 0;
  return Math.max(0, Math.ceil((due - at) / (24 * 3600 * 1000)));
}

/** `US$ 1,069.90`-style amount in the given locale. */
export function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * A day of a statement (cut-offs and due dates are UTC instants: the
 * same calendar day for every reader).
 */
export function formatDay(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(date);
}

/** `1 oct 2026 – 1 nov 2026`. */
export function formatPeriod(
  start: string,
  end: string,
  locale: string
): string {
  return `${formatDay(start, locale)} – ${formatDay(end, locale)}`;
}

/** A price per message: up to five decimals (`0,02825`). */
export function formatRate(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 5,
  }).format(value);
}
