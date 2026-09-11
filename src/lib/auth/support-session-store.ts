// ============================================================
// The bitácora row as the source of truth for "is this session still
// open?".
//
// Why this is not folded into `impersonation-log.ts`: that module imports
// `impersonation.ts` (to read and verify the cookie), and `impersonation.ts`
// needs this check inside `resolveSupportSession`. One module, one
// direction, no cycle.
//
// Why the check exists at all: a signed cookie is a bearer token, and
// `httpOnly` does not hide it from its OWNER — the operator can read it
// out of devtools. Without this, pressing "exit support session" would
// clear the browser's copy while leaving the token itself perfectly valid
// for the rest of its 30 minutes, and the bitácora would already say
// `ended_reason = 'manual'`. That is impersonation that is not recorded:
// the single outcome this feature exists to prevent.
//
// Migration 057 puts the same condition in the RLS predicate
// (`has_open_support_session`), so the browser's direct reads die with the
// row too. This is the server half of the same rule.
// ============================================================

import { supabaseAdmin } from './admin-client';

/**
 * True iff the bitácora row is still open and has not run out of time.
 *
 * Scoped by the row id AND the account it names AND the actor — all three
 * come from the signed cookie, never from a request body. The account
 * filter is what keeps this service-role read under the repo's tenant rule
 * (CP3).
 *
 * Fails CLOSED: a database error is `false`, not an exception. A degraded
 * database must not be the reason a revoked session keeps working.
 */
export async function isSupportSessionOpen(session: {
  logId: string;
  accountId: string;
  actorUserId: string;
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('impersonation_log')
    .select('id, expires_at')
    .eq('id', session.logId)
    .eq('account_id', session.accountId)
    .eq('actor_user_id', session.actorUserId)
    .is('ended_at', null)
    .maybeSingle();

  if (error) {
    console.error('[impersonation] open-session lookup failed:', error);
    return false;
  }
  if (!data) return false;

  // The row's own deadline, not the cookie's. They are written together,
  // but only one of the two is out of the holder's reach.
  const expiresAt = Date.parse((data.expires_at as string) ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  return true;
}

/**
 * Close every support-session row that has run out of time, whoever opened
 * it. Returns how many were closed (0 on the overwhelmingly common path).
 *
 * Called from `/api/platform/impersonate` (GET and POST) and from
 * `/stop` — the three moments an operator touches the panel. The reason
 * it lives there instead of in a cron: the rows only ever appear because
 * an operator opened one, `ended_at IS NULL AND expires_at < now()` is an
 * index-only scan on `idx_impersonation_log_open`, and a new cron endpoint
 * would mean a new shared secret and a new unauthenticated route to
 * defend — a worse trade for a table that grows by a handful of rows a
 * week. The honest limit: if NO operator ever opens the panel again, the
 * last stale row stays open. `expires_at` is on the row either way, so the
 * real window is auditable regardless of `ended_at`.
 *
 * Deliberately NOT scoped by account: closing expired rows across every
 * account is the entire job, it moves no customer data, and
 * `impersonation_log` is the platform's own bitácora rather than tenant
 * data (same footing as `platform_admins`). Waived by name in
 * `tenant-isolation.test.ts`.
 */
export async function sweepExpiredSupportSessions(): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from('impersonation_log')
    .update({ ended_at: new Date().toISOString(), ended_reason: 'expired' })
    .is('ended_at', null)
    .lt('expires_at', new Date().toISOString())
    .select('id');

  if (error) {
    // A hole in the audit trail, not a reason to refuse the request the
    // operator actually made. Loud in the logs, invisible to the caller.
    console.error('[impersonation] expiry sweep failed:', error);
    return 0;
  }
  return data?.length ?? 0;
}
