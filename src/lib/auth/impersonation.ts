// ============================================================
// Support sessions (impersonation) — the mechanism.
//
// What a support session is NOT: it never touches `profiles.account_id`
// of the operator. Moving a real row to "become" another company would
// mean a crash, a lost cookie or a forgotten logout leaves a human being
// permanently inside someone else's data, and every audit afterwards
// would show their own account as the one that acted. The account swap
// has to be something the server derives per request and that expires by
// itself — not persisted state.
//
// So: a signed, httpOnly cookie. Its payload names the operator, the
// target account, the row in `impersonation_log` that opened the session,
// and when it expires. It is signed with HMAC-SHA256 under a key derived
// from `ENCRYPTION_KEY` (no new environment variable), so the browser
// cannot forge or extend one.
//
// The cookie alone grants nothing. `resolveSupportSession` re-checks, on
// every request:
//
//   1. the signature verifies (constant-time compare);
//   2. the session has not expired;
//   3. the signed actor IS the currently authenticated user — a cookie
//      copied into another browser is worthless;
//   4. that user is STILL in `platform_admins` — revoking an operator
//      ends their open sessions on the next request, without having to
//      hunt down cookies;
//   5. the `impersonation_log` row it names is STILL OPEN and has not run
//      out of time — pressing "exit" revokes the token itself, not just
//      the browser's copy of it.
//
// Anything less than all five resolves to `null` and the caller keeps
// their own account. Fails closed.
//
// A support session is read-only, and that is enforced in three places
// because there are three ways out of this application:
//
//   - RLS (migration 057): only SELECT policies learned the support
//     predicate, so the impersonated account cannot be written to AT ALL —
//     including by requests the browser sends straight to Supabase;
//   - `middleware.ts`: every mutating request that does reach Next gets a
//     403, whatever route it was headed for;
//   - `@/lib/supabase/client`: the browser client refuses to mutate
//     anything while the session is open, which is what stops an operator
//     from editing their OWN company by mistake under the customer's
//     banner.
//
// The effective role is `viewer` on top of all that. Support is for seeing
// what the customer sees; acting on their behalf is a different feature
// with a different conversation about consent.
// ============================================================

import crypto from 'crypto';
import { cookies } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';

import { isPlatformAdmin } from './platform-admins';
import {
  SUPPORT_ACTIVE_COOKIE,
  SUPPORT_COOKIE,
  SUPPORT_SESSION_TTL_MS,
} from './support-cookie';
import { isSupportSessionOpen } from './support-session-store';

export { SUPPORT_ACTIVE_COOKIE, SUPPORT_COOKIE, SUPPORT_SESSION_TTL_MS };

/**
 * Minimum length of the reason recorded in `impersonation_log`. Mirrored
 * by a CHECK constraint in migration 055: a bitácora full of "ok" audits
 * nothing, and the route is not the only way a row could be inserted.
 */
export const MIN_REASON_LENGTH = 10;

/** What the signed cookie carries. Kept small — it travels on every request. */
export interface SupportSession {
  /** `impersonation_log.id` of the row that opened this session. */
  logId: string;
  /** The platform admin doing the impersonating. */
  actorUserId: string;
  /** Account being viewed. */
  accountId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

// ------------------------------------------------------------
// Signing
// ------------------------------------------------------------

/**
 * Domain-separated signing key: HMAC(ENCRYPTION_KEY, label). Deriving
 * rather than using `ENCRYPTION_KEY` directly means a support cookie can
 * never be confused with — or used as an oracle for — the secret-at-rest
 * encryption that shares the same environment variable.
 */
function signingKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('ENCRYPTION_KEY is not set');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes as 64 hex characters');
  }
  return crypto
    .createHmac('sha256', Buffer.from(hex.trim(), 'hex'))
    .update('wacrm:support-session:v1')
    .digest();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** `<payload>.<hmac>`, both base64url. */
export function signSupportSession(session: SupportSession): string {
  const payload = b64url(Buffer.from(JSON.stringify(session), 'utf8'));
  const mac = b64url(
    crypto.createHmac('sha256', signingKey()).update(payload).digest()
  );
  return `${payload}.${mac}`;
}

/**
 * The session a token carries, or `null` if the signature does not verify,
 * the payload is malformed, or it has expired. No exceptions: a bad cookie
 * is a normal condition, not an error.
 */
export function verifySupportSession(
  token: string,
  now: number = Date.now()
): SupportSession | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;

  let expected: Buffer;
  try {
    expected = crypto
      .createHmac('sha256', signingKey())
      .update(payload)
      .digest();
  } catch {
    // Misconfigured ENCRYPTION_KEY. Fail closed rather than 500 on every
    // request that happens to carry the cookie.
    return null;
  }

  const supplied = Buffer.from(mac, 'base64url');
  // Length check first: timingSafeEqual throws on a length mismatch, which
  // would turn a truncated cookie into a 500.
  if (supplied.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(supplied, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const { logId, actorUserId, accountId, expiresAt } = parsed as Record<
    string,
    unknown
  >;
  if (
    typeof logId !== 'string' ||
    typeof actorUserId !== 'string' ||
    typeof accountId !== 'string' ||
    typeof expiresAt !== 'number'
  ) {
    return null;
  }
  if (!(expiresAt > now)) return null;

  return { logId, actorUserId, accountId, expiresAt };
}

// ------------------------------------------------------------
// Cookie plumbing
// ------------------------------------------------------------

/**
 * The raw cookie value, or `null`.
 *
 * `cookies()` throws outside a request scope (a unit test importing this
 * module, a background job). That is "no support session", not a crash.
 */
export async function readSupportCookie(): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(SUPPORT_COOKIE)?.value ?? null;
  } catch (err) {
    // Next signals "this segment bailed out of prerendering" by THROWING
    // from `cookies()`. Swallowing that would silently prerender the
    // dashboard shell without the support banner — the one warning that
    // must never be missing. `unstable_rethrow` lets the framework's own
    // control-flow errors through and keeps only the real ones.
    unstable_rethrow(err);
    return null;
  }
}

/**
 * Write the cookie — both of them. Only callable from a Route Handler /
 * Server Function.
 *
 * The signed one is `httpOnly` and carries the session. The companion flag
 * is readable by JavaScript on purpose and carries the impersonated
 * `account_id`: it is how the browser bundle learns to refuse writes and
 * which account every list must filter by (see `SUPPORT_ACTIVE_COOKIE`).
 * They are written and dropped together, here, so the two can never drift.
 *
 * The flag grants nothing the signed cookie does not already grant — it is
 * a uuid the holder could rewrite, and rewriting it only narrows their own
 * queries.
 */
export async function setSupportCookie(
  token: string,
  expiresAt: number,
  accountId: string
): Promise<void> {
  const store = await cookies();
  // Seconds, and never negative: a clock skew that makes the session
  // already-expired must still produce a cookie the browser drops soon,
  // not a session cookie that outlives the tab.
  const maxAge = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  store.set(SUPPORT_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  });
  store.set(SUPPORT_ACTIVE_COOKIE, accountId, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  });
}

/** Drop both cookies. Only callable from a Route Handler / Server Function. */
export async function clearSupportCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SUPPORT_COOKIE);
  store.delete(SUPPORT_ACTIVE_COOKIE);
}

// ------------------------------------------------------------
// Resolution
// ------------------------------------------------------------

/**
 * The support session in force for `authenticatedUserId`, or `null`.
 *
 * All five checks from the header run here. Callers get either a fully
 * validated session or nothing; there is no "partially trusted" shape.
 */
export async function resolveSupportSession(
  authenticatedUserId: string
): Promise<SupportSession | null> {
  const raw = await readSupportCookie();
  if (!raw) return null;

  const session = verifySupportSession(raw);
  if (!session) return null;

  // A cookie replayed from another browser names an actor who is not the
  // one holding this Supabase session. Never honour it.
  if (session.actorUserId !== authenticatedUserId) return null;

  // Revoking an operator must end their open sessions, not merely stop new
  // ones. This is the check that makes that true.
  if (!(await isPlatformAdmin(authenticatedUserId))) return null;

  // The bitácora row is the session; the cookie is only a claim about it.
  // `httpOnly` hides the cookie from other sites, not from its own holder:
  // without this check an operator could copy the token out of devtools,
  // press "exit", put it back, and keep working inside the customer's
  // account for the rest of the 30 minutes with the audit trail already
  // saying the session ended. One extra query, only on the rare path where
  // a support cookie is actually present.
  if (!(await isSupportSessionOpen(session))) return null;

  return session;
}
