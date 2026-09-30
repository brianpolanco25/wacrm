// ============================================================
// Where Supabase Auth sends people back to (s9.8).
//
// Every email Supabase writes for this app — the sign-up confirmation,
// the password recovery, the invitation an operator (s9.4) or a team
// admin sends — carries a `redirect_to`. All of them point at ONE
// place, `/auth/callback`, which turns whatever the link brings (a PKCE
// `code`, a `token_hash` + `type`, or the tokens of the implicit flow in
// the URL fragment) into session cookies and then decides where the
// person goes next:
//
//   invite / recovery  → /reset-password   (choose a password first)
//   ?invite=<token>    → /join/<token>     (accept the team invitation)
//   ?next=/some/path   → that path         (same-origin paths only)
//   anything else      → /dashboard        (or /platform for an operator,
//                                           decided in the browser by
//                                           `postLoginDestination`)
//
// `?invite=` survives the whole trip: callback → reset-password → join,
// the same way `/signup` has always carried it through verification.
//
// The URLs built here must be allow-listed in Supabase Auth → URL
// Configuration → Redirect URLs (see docs/docker.md): an URL that is not
// there is silently replaced by the Site URL.
// ============================================================

export const AUTH_CALLBACK_PATH = '/auth/callback';
/** The browser half of the callback: reads the URL fragment. */
export const AUTH_CALLBACK_COMPLETE_PATH = '/auth/callback/complete';
export const RESET_PASSWORD_PATH = '/reset-password';

/** Link types after which the person must choose a password. */
const PASSWORD_TYPES = new Set(['invite', 'recovery']);

/** Throwaway origin to resolve relative paths against. */
const PROBE_ORIGIN = 'http://same.origin.invalid';

/**
 * True when `path` — the FINAL string a browser will navigate to — is a
 * path on this site: exactly one leading `/`, not followed by another
 * `/` or a `\`, no control characters, and it resolves to the same
 * origin and to itself (so no `.`/`..` segment is left to collapse into
 * `//host` later). Also checked once percent-decoded, so `/%2F%2Fhost`
 * or `/%5Chost` are refused as well.
 */
export function isSameOriginPath(path: string): boolean {
  const shape = (p: string) =>
    p.startsWith('/') &&
    p[1] !== '/' &&
    p[1] !== '\\' &&
    !/[\\\u0000-\u001f\u007f]/.test(p);
  if (!shape(path)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.split(/[?#]/)[0]);
  } catch {
    return false;
  }
  if (!shape(decoded)) return false;
  try {
    const url = new URL(path, PROBE_ORIGIN);
    if (url.origin !== PROBE_ORIGIN) return false;
    return `${url.pathname}${url.search}${url.hash}` === path;
  } catch {
    return false;
  }
}

/**
 * `next` as a same-origin path, or `null` when it is anything else.
 *
 * `next` arrives in a query string anybody can write. It is normalised
 * with `new URL` (which resolves `.` and `..`) and then the RESULT is
 * validated with `isSameOriginPath`: checking only the raw input let
 * `/.//evil.com`, `/..//evil.com`, `/%2e//evil.com` or `/a/..//evil.com`
 * through, all of which normalise to `//evil.com` — another host.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/')) return null;
  // `new URL` silently drops tabs and newlines and turns `\` into `/`;
  // refuse them on the way in rather than let the parser "fix" them.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return null;
  try {
    const url = new URL(next, PROBE_ORIGIN);
    if (url.origin !== PROBE_ORIGIN) return null;
    const result = `${url.pathname}${url.search}${url.hash}`;
    return isSameOriginPath(result) ? result : null;
  } catch {
    return null;
  }
}

/** `path` with `invite=<token>` added to its query string. */
function withInvite(path: string, invite: string | null | undefined): string {
  if (!invite) return path;
  const url = new URL(path, PROBE_ORIGIN);
  url.searchParams.set('invite', invite);
  return `${url.pathname}${url.search}`;
}

/** The page where a signed-in person chooses a password. */
export function resetPasswordPath(opts: {
  invite?: string | null;
  welcome?: boolean;
}): string {
  const params = new URLSearchParams();
  if (opts.invite) params.set('invite', opts.invite);
  if (opts.welcome) params.set('welcome', '1');
  const qs = params.toString();
  return qs ? `${RESET_PASSWORD_PATH}?${qs}` : RESET_PASSWORD_PATH;
}

/**
 * The `redirectTo` / `emailRedirectTo` every Supabase Auth email must
 * use: `inviteUserByEmail`, `resetPasswordForEmail` and `signUp`.
 *
 *   authCallbackUrl(origin)                                  sign-up
 *   authCallbackUrl(origin, { next: '/reset-password' })     recovery, owner invite
 *   authCallbackUrl(origin, { next: '/reset-password',
 *                             invite: token })               member invite
 */
export function authCallbackUrl(
  origin: string,
  opts: { next?: string | null; invite?: string | null } = {}
): string {
  const base = origin.replace(/\/+$/, '');
  const params = new URLSearchParams();
  const next = safeNextPath(opts.next);
  if (next) params.set('next', next);
  if (opts.invite) params.set('invite', opts.invite);
  const qs = params.toString();
  return `${base}${AUTH_CALLBACK_PATH}${qs ? `?${qs}` : ''}`;
}

/**
 * Where to go once the link has become a session, or `null` when
 * nothing in the link says — the caller then picks the default
 * (`/dashboard` on the server, `postLoginDestination` in the browser).
 *
 * The link's own `type` wins over `next`: an invitation or a recovery
 * always goes through `/reset-password`, whatever `next` claims,
 * because without a password the person cannot sign in again tomorrow.
 */
export function callbackDestination(opts: {
  type?: string | null;
  next?: string | null;
  invite?: string | null;
}): string | null {
  const destination = rawDestination(opts);
  // Whatever was built, it is checked once more as the final string.
  return destination && isSameOriginPath(destination) ? destination : null;
}

function rawDestination(opts: {
  type?: string | null;
  next?: string | null;
  invite?: string | null;
}): string | null {
  const invite = opts.invite || null;
  if (opts.type && PASSWORD_TYPES.has(opts.type)) {
    return resetPasswordPath({ invite, welcome: opts.type === 'invite' });
  }
  const next = safeNextPath(opts.next);
  if (next) {
    const nextPath = next.split(/[?#]/)[0];
    return nextPath === RESET_PASSWORD_PATH ? withInvite(next, invite) : next;
  }
  if (invite) return `/join/${encodeURIComponent(invite)}`;
  return null;
}
