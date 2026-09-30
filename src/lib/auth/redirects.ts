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

/**
 * `next` as a same-origin path, or `null` when it is anything else.
 *
 * `next` arrives in a query string anybody can write, so a bare
 * `startsWith('/')` would still let `//evil.example` or `/\evil.example`
 * through — both of which browsers treat as another host. Parsing it
 * against a throwaway origin and requiring that origin back is what
 * rules those out.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null;
  if (/[\\\u0000-\u001f]/.test(next)) return null;
  try {
    const base = 'http://same.origin.invalid';
    const url = new URL(next, base);
    if (url.origin !== base) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** `path` with `invite=<token>` added to its query string. */
function withInvite(path: string, invite: string | null | undefined): string {
  if (!invite) return path;
  const url = new URL(path, 'http://same.origin.invalid');
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
