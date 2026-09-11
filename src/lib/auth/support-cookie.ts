// Name and lifetime of the support-session cookie, in a module with NO
// imports on purpose.
//
// `src/middleware.ts` runs on the Edge runtime and needs the cookie name to
// refuse writes while a support session is open. Importing it from
// `impersonation.ts` would drag `node:crypto` into the edge bundle; this
// file keeps the one constant both sides need free of that.

/**
 * Signed, httpOnly cookie that carries an open support session. Its mere
 * presence puts the request in read-only mode (see `middleware.ts`); what
 * it *grants* is decided only after verifying the signature server-side
 * (`resolveSupportSession` in `impersonation.ts`).
 */
export const SUPPORT_COOKIE = 'wacrm_support_session';

/**
 * How long a support session lasts. Short on purpose: impersonation is for
 * looking at one reported problem, not for keeping a second desk open. The
 * cookie's own `maxAge` matches it, so an operator who closes the browser
 * without pressing "exit" is out within the window instead of indefinitely.
 */
export const SUPPORT_SESSION_TTL_MS = 30 * 60 * 1000;
