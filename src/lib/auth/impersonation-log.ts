// ============================================================
// The bitácora side of a support session: reading the cookie that is in
// force and closing the row it opened.
//
// Shared by `/api/platform/impersonate` (open, inspect) and
// `/api/platform/impersonate/stop` (close) so both spell "this session
// ended" the same way — a half-written audit trail is worse than none,
// because it looks complete.
// ============================================================

import { supabaseAdmin } from './admin-client';
import {
  readSupportCookie,
  verifySupportSession,
  type SupportSession,
} from './impersonation';

/** How a session ended. Mirrors the CHECK on `impersonation_log`. */
export type EndReason = 'manual' | 'expired' | 'superseded';

/** Shape the API hands to the browser. */
export interface SessionView {
  log_id: string;
  account_id: string;
  account_name: string | null;
  expires_at: string;
}

export function sessionView(
  session: SupportSession,
  accountName: string | null
): SessionView {
  return {
    log_id: session.logId,
    account_id: session.accountId,
    account_name: accountName,
    expires_at: new Date(session.expiresAt).toISOString(),
  };
}

/**
 * Close an open bitácora row.
 *
 * Scoped by the row id AND by the account the signed cookie names. The id
 * never comes from the request body, and the redundant account filter
 * keeps this service-role write under the same tenant rule as every other
 * one in the repo (CP3) rather than resting on "the id is unguessable".
 *
 * `.is('ended_at', null)` makes it idempotent: pressing exit twice, or a
 * stop racing an expiry sweep, closes the row once and leaves the first
 * `ended_reason` standing.
 */
export async function closeImpersonationLog(
  session: SupportSession,
  reason: EndReason
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('impersonation_log')
    .update({ ended_at: new Date().toISOString(), ended_reason: reason })
    .eq('id', session.logId)
    .eq('account_id', session.accountId)
    .is('ended_at', null);

  if (error) {
    // Not fatal for the caller — the cookie is what grants access and it
    // is dropped either way — but it IS a hole in the audit trail, so it
    // has to be loud in the logs.
    console.error('[impersonation] could not close the log row:', error);
  }
}

/**
 * What the cookie currently carries, split into "still valid" and "signed
 * correctly but past its deadline".
 *
 * The expired half matters: its bitácora row is still open and somebody
 * has to close it. Verifying a second time against epoch 0 tells a real
 * expired session apart from a forged cookie — only the former had a
 * valid signature.
 */
export async function readCurrentSession(): Promise<{
  session: SupportSession | null;
  expired: SupportSession | null;
}> {
  const raw = await readSupportCookie();
  if (!raw) return { session: null, expired: null };

  const live = verifySupportSession(raw);
  if (live) return { session: live, expired: null };

  return { session: null, expired: verifySupportSession(raw, 0) };
}
