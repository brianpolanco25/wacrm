// ============================================================
// /signup?invite=<token> (i12.1).
//
// The invitation is checked BEFORE the form shows (peek), and the token
// travels in `options.data.invite_token` of `signUp`, where
// `handle_new_user()` (migration 090) reads it: the person is born
// inside the company with the invitation's role, without a personal
// account in between. If the invitation is no longer good when the form
// is sent, the trigger aborts the whole signup and GoTrue answers
// «Database error saving new user»; the page then asks peek again and
// shows the reason instead of that text.
// ============================================================

import { parsePeek, type InvitePeek, type JoinFailReason } from './join-flow';
import { authCallbackUrl } from './redirects';

export type SignupInviteGate =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ok'; peek: InvitePeek }
  | { kind: 'fail'; reason: JoinFailReason };

/**
 * What the page shows for this `?invite=` and peek answer.
 * `peek === undefined` means "not answered yet".
 */
export function signupInviteGate(
  token: string | null,
  peek: unknown | undefined
): SignupInviteGate {
  if (!token) return { kind: 'none' };
  if (peek === undefined) return { kind: 'loading' };
  const parsed = parsePeek(peek);
  return parsed.ok
    ? { kind: 'ok', peek: parsed.peek }
    : { kind: 'fail', reason: parsed.reason };
}

/** The `options` of `supabase.auth.signUp`. */
export function signupOptions(opts: {
  fullName: string;
  inviteToken: string | null;
  origin: string;
}): {
  data: { full_name: string; invite_token?: string };
  emailRedirectTo: string;
} {
  return {
    data: {
      full_name: opts.fullName,
      ...(opts.inviteToken ? { invite_token: opts.inviteToken } : {}),
    },
    // The confirmation email comes back through /auth/callback (s9.8),
    // which keeps `?invite=` on to /join/<token>: there the person is
    // already a member and the automatic redeem is a no-op.
    emailRedirectTo: authCallbackUrl(opts.origin, { invite: opts.inviteToken }),
  };
}

/** GoTrue's answer when a database trigger aborted the new user. */
const TRIGGER_ABORT = 'Database error saving new user';

/**
 * True when a `signUp` error means "the database refused the user" —
 * with an invitation, that is the trigger rejecting it — rather than a
 * form problem (weak password, bad email, rate limit).
 */
export function isInviteSignupRejection(
  err: { status?: number; message?: string } | null | undefined
): boolean {
  if (!err) return false;
  if (typeof err.status === 'number' && err.status >= 500) return true;
  return (err.message ?? '').includes(TRIGGER_ABORT);
}
