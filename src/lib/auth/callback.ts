// ============================================================
// Turning a Supabase Auth email link into a session (s9.8).
//
// A link comes back to `/auth/callback` in one of three shapes, and
// which one depends on who asked for the email and on the template:
//
//   ?code=<uuid>                PKCE. `signUp` / `resetPasswordForEmail`
//                               from this app's browser client (which
//                               is PKCE) with the DEFAULT template
//                               (`{{ .ConfirmationURL }}`). The code is
//                               useless without the verifier cookie
//                               the same browser wrote when it asked.
//
//   ?token_hash=…&type=…        A template that links straight to the
//                               app with `{{ .TokenHash }}` (see
//                               docs/docker.md). Works for every email,
//                               in any browser, and is the only way an
//                               INVITATION can reach the server.
//
//   #access_token=…&type=…      The implicit flow. What
//                               `auth.admin.inviteUserByEmail` sends
//                               with the default template: the invite
//                               is created server-side, there is no
//                               PKCE verifier, so GoTrue hands the
//                               tokens over in the fragment. The server
//                               never sees a fragment, so the route
//                               forwards to a browser page that does.
//
// Errors (an expired or reused link) come back as `error`, `error_code`
// and `error_description` — in the query for PKCE, in the fragment for
// the implicit flow.
//
// The server half (`resolveCallback`) and the browser half
// (`completeAuthCallback`) are plain functions over an injected auth
// client, so the tests exercise every branch without a network.
// ============================================================

import type { EmailOtpType, SupabaseClient } from '@supabase/supabase-js';

import { postLoginDestination } from './post-login';
import { AUTH_CALLBACK_COMPLETE_PATH, callbackDestination } from './redirects';

type Auth = SupabaseClient['auth'];

/** What a failed link tells the person. */
export type CallbackErrorReason =
  'expired' | 'otherBrowser' | 'invalid' | 'missing';

/** Email OTP types `verifyOtp` accepts with a `token_hash`. */
const OTP_TYPES = new Set<string>([
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
]);

/** Default landing when the link names neither a type nor a place. */
const SERVER_DEFAULT_DESTINATION = '/dashboard';

/** Map a GoTrue error code to the sentence the person gets. */
export function callbackErrorReason(
  code: string | null | undefined
): CallbackErrorReason {
  switch (code) {
    case 'otp_expired':
    case 'flow_state_expired':
    case 'flow_state_not_found':
    case 'refresh_token_already_used':
    case 'refresh_token_not_found':
    case 'session_expired':
      return 'expired';
    case 'pkce_code_verifier_not_found':
    case 'bad_code_verifier':
      return 'otherBrowser';
    case 'missing':
      return 'missing';
    default:
      return 'invalid';
  }
}

/** The browser page, carrying `next`/`invite` and, if any, the error. */
function completePath(
  params: URLSearchParams,
  errorCode?: string | null
): string {
  const out = new URLSearchParams();
  for (const key of ['next', 'invite']) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  if (errorCode) out.set('error_code', errorCode);
  const qs = out.toString();
  return qs
    ? `${AUTH_CALLBACK_COMPLETE_PATH}?${qs}`
    : AUTH_CALLBACK_COMPLETE_PATH;
}

/**
 * Server half: exchange the `code` or verify the `token_hash`, writing
 * the session cookies through the SSR client, and say where to redirect.
 *
 * Anything it cannot finish itself — an error, or a link whose session
 * travels in the fragment — goes to the browser page, with `next` and
 * `invite` preserved. A browser keeps the fragment across a redirect
 * whose `Location` has none (Fetch standard, "HTTP-redirect fetch"), so
 * `#access_token=…` reaches that page intact.
 */
export async function resolveCallback(
  params: URLSearchParams,
  auth: Pick<Auth, 'exchangeCodeForSession' | 'verifyOtp'>
): Promise<string> {
  const next = params.get('next');
  const invite = params.get('invite');

  if (
    params.get('error') ||
    params.get('error_code') ||
    params.get('error_description')
  ) {
    return completePath(params, params.get('error_code') || 'unknown');
  }

  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  if (tokenHash) {
    if (!type || !OTP_TYPES.has(type)) return completePath(params, 'invalid');
    const { error } = await auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    if (error) return completePath(params, error.code || 'invalid');
    return (
      callbackDestination({ type, next, invite }) ?? SERVER_DEFAULT_DESTINATION
    );
  }

  const code = params.get('code');
  if (code) {
    const { data, error } = await auth.exchangeCodeForSession(code);
    if (error) return completePath(params, error.code || 'invalid');
    // `redirectType` is 'recovery' when the verifier was written by
    // `resetPasswordForEmail`; the link itself says nothing. auth-js
    // returns it at runtime (`_exchangeCodeForSession`) but its public
    // type does not declare it, hence the narrow read.
    const redirectType =
      (data as { redirectType?: string | null } | null)?.redirectType ?? null;
    return (
      callbackDestination({ type: redirectType, next, invite }) ??
      SERVER_DEFAULT_DESTINATION
    );
  }

  return completePath(params);
}

export type ParsedFragment =
  | {
      kind: 'tokens';
      accessToken: string;
      refreshToken: string;
      type: string | null;
    }
  | { kind: 'error'; code: string }
  | { kind: 'none' };

/** Read the implicit-flow fragment (`#access_token=…` or `#error=…`). */
export function parseAuthFragment(hash: string): ParsedFragment {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (
    params.get('error') ||
    params.get('error_code') ||
    params.get('error_description')
  ) {
    return { kind: 'error', code: params.get('error_code') || 'unknown' };
  }
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) {
    return {
      kind: 'tokens',
      accessToken,
      refreshToken,
      type: params.get('type'),
    };
  }
  return { kind: 'none' };
}

export type CompleteResult =
  | { ok: true; destination: string }
  | { ok: false; reason: CallbackErrorReason };

/**
 * Browser half. Order of precedence:
 *
 *   1. an error in the query (from the route) or in the fragment;
 *   2. tokens in the fragment → `setSession` (writes the cookies);
 *   3. no tokens but a session already open (the link was opened twice,
 *      or the route already did the work) → carry on;
 *   4. nothing at all → "this link is not valid".
 *
 * `setSession` is called explicitly because the browser client is PKCE:
 * its own `detectSessionInUrl` refuses an implicit-flow fragment
 * ("Not a valid PKCE flow url") and leaves it unused.
 */
export async function completeAuthCallback(opts: {
  hash: string;
  search: string;
  auth: Pick<Auth, 'setSession' | 'getUser'>;
  fetchImpl?: typeof fetch;
}): Promise<CompleteResult> {
  const query = new URLSearchParams(opts.search);
  const next = query.get('next');
  const invite = query.get('invite');

  const queryError = query.get('error_code');
  if (queryError) return { ok: false, reason: callbackErrorReason(queryError) };

  const fragment = parseAuthFragment(opts.hash);
  if (fragment.kind === 'error') {
    return { ok: false, reason: callbackErrorReason(fragment.code) };
  }

  let type: string | null = null;
  if (fragment.kind === 'tokens') {
    const { error } = await opts.auth.setSession({
      access_token: fragment.accessToken,
      refresh_token: fragment.refreshToken,
    });
    if (error) return { ok: false, reason: callbackErrorReason(error.code) };
    type = fragment.type;
  } else {
    const { data } = await opts.auth.getUser();
    if (!data?.user) return { ok: false, reason: 'missing' };
  }

  const destination =
    callbackDestination({ type, next, invite }) ??
    (await postLoginDestination(invite, opts.fetchImpl));
  return { ok: true, destination };
}
