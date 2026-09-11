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
 * Companion flag cookie, deliberately NOT `httpOnly`: it is how the server
 * tells the browser bundle "you are inside a support session".
 *
 * It carries no authority whatsoever — it is a single `1` and grants
 * nothing. What it does is let `@/lib/supabase/client` refuse to mutate
 * anything (see `guardReadOnly`), which matters because most of this panel
 * talks to Supabase STRAIGHT FROM THE BROWSER with the operator's own JWT:
 * those requests never reach Next, so neither the middleware nor the
 * effective `viewer` role ever sees them, and RLS runs them against the
 * OPERATOR'S own account. Without this flag an operator could delete their
 * own company's contacts while the banner says nothing is being saved.
 *
 * Threat model, stated plainly: anyone who can write cookies in their own
 * browser can also delete this one. Doing so buys them nothing they did
 * not already have — they would still be writing to their own account,
 * which they can do by leaving the support session. It is a guard rail
 * against a mistake, not a security boundary; the boundary for the
 * CUSTOMER'S data is RLS (migration 057 extends only SELECT policies, so
 * a support session cannot write to the impersonated account at all).
 */
export const SUPPORT_ACTIVE_COOKIE = 'wacrm_support_active';

/**
 * How long a support session lasts. Short on purpose: impersonation is for
 * looking at one reported problem, not for keeping a second desk open. The
 * cookie's own `maxAge` matches it, so an operator who closes the browser
 * without pressing "exit" is out within the window instead of indefinitely.
 */
export const SUPPORT_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * The actor named inside a support token, WITHOUT verifying its signature,
 * or `null` if the token is not even shaped like one.
 *
 * Only `src/middleware.ts` uses it, and only to answer one question: "is
 * this cookie mine?". The Edge runtime has no `node:crypto`, so the
 * middleware cannot check the signature — and for this question it does
 * not need to. Trusting an unverified claim would be a mistake if it
 * GRANTED something; here it only ever takes the read-only block AWAY from
 * a browser whose logged-in user is not the actor, which is the case where
 * the block was doing nothing but stranding an innocent bystander: a
 * cookie left behind on a shared machine used to 403 every save the next
 * person made for half an hour, with no banner and no exit button, because
 * `resolveSupportSession` (correctly) refused to call it their session.
 *
 * Forging a cookie with somebody else's uid inside still only achieves
 * what it achieved before: locking the forger's own browser out of writes.
 */
export function supportCookieActor(token: string): string | null {
  const payload = token.split('.')[0];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const actor = (parsed as Record<string, unknown>).actorUserId;
    return typeof actor === 'string' ? actor : null;
  } catch {
    return null;
  }
}
