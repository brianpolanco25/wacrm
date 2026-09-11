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
 * tells the browser bundle "you are inside a support session, and THIS is
 * the account you are looking at".
 *
 * Its value is the impersonated `account_id`. That matters twice:
 *
 *   - it lets `@/lib/supabase/client` refuse to mutate anything (see
 *     `guardReadOnly`), which stops an operator from editing their OWN
 *     company by mistake under the customer's banner;
 *   - it lets every list in this panel filter by the account it is
 *     supposed to be showing. Most of the panel talks to Supabase
 *     STRAIGHT FROM THE BROWSER with the operator's own JWT: those
 *     requests never reach Next, so neither the middleware nor the
 *     effective `viewer` role ever sees them. Before migration 057 RLS
 *     answered them with the operator's own rows; after 057 it answers
 *     with BOTH companies' rows, because a SELECT policy that says "my
 *     accounts OR the one I am supporting" is no longer a filter for one
 *     account. The browser has to supply that filter itself, and this is
 *     where it learns which account to ask for.
 *
 * Threat model, stated plainly: anyone who can write cookies in their own
 * browser can also delete or rewrite this one. Neither buys them anything.
 * Deleting it restores writes to their OWN account, which they can already
 * do by leaving the session. Rewriting it with another account's uuid only
 * adds `account_id = <that uuid>` to their own queries — an extra WHERE
 * can only ever REMOVE rows, and RLS still decides which ones come back
 * (the answer for an account they hold no session on is none). It is a
 * guard rail and a view selector, not a security boundary; the boundary
 * for the CUSTOMER'S data is RLS (migration 057 extends only SELECT
 * policies, so a support session cannot write to the impersonated account
 * at all).
 */
export const SUPPORT_ACTIVE_COOKIE = 'wacrm_support_active';

/**
 * The value of the flag cookie inside `cookieString` (a `document.cookie`
 * string), or `null` when it is not there.
 *
 * Pure on purpose — the browser passes `document.cookie`, and the tests
 * pass a string. Matches the whole cookie NAME, so `not_wacrm_support_active`
 * is not mistaken for it.
 */
export function supportFlagValue(cookieString: string): string | null {
  for (const part of cookieString.split(';')) {
    const raw = part.trim();
    if (!raw.startsWith(`${SUPPORT_ACTIVE_COOKIE}=`)) continue;
    return raw.slice(SUPPORT_ACTIVE_COOKIE.length + 1);
  }
  return null;
}

/** Shape of the uuid the flag cookie is supposed to carry. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The impersonated account named by the flag cookie, or `null` when the
 * value is not a uuid.
 *
 * Reading a junk value as "no session" would be the wrong failure: the
 * flag being present at all means the panel must NOT fall back to the
 * operator's own account, which is the mislabelled view this whole round
 * is about. Callers combine the two questions — "is there a session?"
 * (`supportFlagValue`) and "which account?" (this) — and fail closed when
 * the first says yes and the second says nothing.
 */
export function supportAccountFromFlag(value: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  return UUID_RE.test(decoded) ? decoded : null;
}

/** `supportAccountFromFlag` applied to a whole `document.cookie` string. */
export function supportFlagAccountId(cookieString: string): string | null {
  const value = supportFlagValue(cookieString);
  return value === null ? null : supportAccountFromFlag(value);
}

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
