// ============================================================
// Choosing a password on /reset-password (s9.8).
//
// Reached with a session already open — by `/auth/callback` after an
// invitation or a recovery link — so the new password goes through
// `auth.updateUser({ password })`, never through a token. Where the
// person lands afterwards is `postLoginDestination` (s9.1): an invite
// token → /join/<token>, an operator → /platform, anyone else →
// /dashboard.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { postLoginDestination } from './post-login';

/** Same floor as /signup (and Supabase's default minimum). */
export const MIN_PASSWORD_LENGTH = 6;

export type NewPasswordError =
  | 'mismatch'
  | 'tooShort'
  | 'samePassword'
  | 'weakPassword'
  | 'noSession'
  | 'failed';

export type NewPasswordResult =
  { ok: true; destination: string } | { ok: false; error: NewPasswordError };

/** The form's own checks, before anything leaves the browser. */
export function validateNewPassword(
  password: string,
  confirm: string
): NewPasswordError | null {
  if (password !== confirm) return 'mismatch';
  if (password.length < MIN_PASSWORD_LENGTH) return 'tooShort';
  return null;
}

/** Map a GoTrue error on `updateUser` to the sentence the form shows. */
function updateError(error: {
  name?: string;
  code?: string;
}): NewPasswordError {
  if (
    error.name === 'AuthSessionMissingError' ||
    error.code === 'session_not_found' ||
    error.code === 'session_expired'
  ) {
    return 'noSession';
  }
  if (error.code === 'same_password') return 'samePassword';
  if (error.code === 'weak_password') return 'weakPassword';
  return 'failed';
}

export async function submitNewPassword(opts: {
  password: string;
  confirm: string;
  invite: string | null;
  auth: Pick<SupabaseClient['auth'], 'updateUser'>;
  fetchImpl?: typeof fetch;
}): Promise<NewPasswordResult> {
  const invalid = validateNewPassword(opts.password, opts.confirm);
  if (invalid) return { ok: false, error: invalid };

  const { error } = await opts.auth.updateUser({ password: opts.password });
  if (error) return { ok: false, error: updateError(error) };

  return {
    ok: true,
    destination: await postLoginDestination(opts.invite, opts.fetchImpl),
  };
}
