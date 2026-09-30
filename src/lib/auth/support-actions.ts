// ============================================================
// The HTTP half of the support-session action log (s9.5).
//
// A support session writes, with effective role `admin`, and every write
// must be in `impersonation_actions` (migration 072). Two writers fill it:
//
//   source='db'    the `record_support_write()` trigger — every row the
//                  operator's JWT writes on the impersonated account,
//                  including the ones the browser sends straight to
//                  PostgREST, which no code of ours ever sees.
//   source='http'  THIS module — one row per mutating request that reaches
//                  a Next route with a verified session. It is what records
//                  the routes that write through the service role (the
//                  trigger cannot see those: `auth.uid()` is NULL there)
//                  and the calls to Meta, which write nothing locally.
//
// Why here and not in the middleware: the middleware runs on Edge and
// cannot verify the cookie (`node:crypto`). It only TAGS the request
// (`x-wacrm-support-*`, see `@/lib/auth/support-scope`); the row is written
// by `resolveSupportSession` after all five checks have passed.
//
// One row per request, however many times the route resolves the session:
// the middleware stamps a fresh `request_id` and the column is UNIQUE, so
// the second insert of the same request is ignored by the database itself.
// That holds across `getCurrentAccount()` + `requireRole()` in one handler
// and across any number of server instances — `React.cache` does neither
// in a Route Handler.
// ============================================================

import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';

import { supabaseAdmin } from './admin-client';
import {
  isMutatingMethod,
  SUPPORT_WRITE_METHOD_HEADER,
  SUPPORT_WRITE_PATH_HEADER,
  SUPPORT_WRITE_REQUEST_HEADER,
  type SupportWriteMethod,
} from './support-scope';

/** What the middleware tagged this request with. */
export interface SupportWrite {
  method: SupportWriteMethod;
  path: string;
  requestId: string;
}

/** The session fields an action row is filed under — all from the signed cookie. */
export interface SupportActionSession {
  logId: string;
  actorUserId: string;
  accountId: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest `path` the table accepts (CHECK in migration 072). */
const MAX_PATH = 2048;

/**
 * The route could not record the action, so it must not perform it. A
 * support write that is not in the bitácora is the one outcome this
 * feature exists to prevent — the same rule f4.4 applied to opening a
 * session ("sin bitácora no hay sesión").
 *
 * It is deliberately NOT "fall back to the operator's own account": that
 * would turn a database hiccup into a write on the wrong company.
 */
export class SupportAuditError extends Error {
  readonly status = 503 as const;
  constructor(
    message = 'Could not record this support action; nothing was changed. Try again.'
  ) {
    super(message);
    this.name = 'SupportAuditError';
  }
}

/**
 * The write this request is, per the middleware's tags, or `null` for a
 * read / an untagged request / no request scope at all (a unit test, a
 * background job).
 */
export async function readSupportWrite(): Promise<SupportWrite | null> {
  let store: Awaited<ReturnType<typeof headers>>;
  try {
    store = await headers();
  } catch (err) {
    // Same reasoning as `readSupportCookie`: let Next's own control-flow
    // throws through, and read "no request scope" as "nothing to record".
    unstable_rethrow(err);
    return null;
  }
  const method = store.get(SUPPORT_WRITE_METHOD_HEADER);
  const path = store.get(SUPPORT_WRITE_PATH_HEADER);
  const requestId = store.get(SUPPORT_WRITE_REQUEST_HEADER);
  if (!method || !path || !requestId) return null;
  if (!isMutatingMethod(method) || !UUID_RE.test(requestId)) return null;
  return { method, path: path.slice(0, MAX_PATH), requestId };
}

/**
 * Write the action row. `true` once it is in the table (or already was —
 * same request resolving the session twice). Never throws: the caller
 * decides what a failure means, and `resolveSupportSession` decides it is
 * a refusal.
 *
 * Service role, filed under the account of the signed session (CP3: the
 * `account_id` is the scope, and it never comes from the request).
 */
export async function recordSupportAction(
  session: SupportActionSession,
  write: SupportWrite
): Promise<boolean> {
  const { error } = await supabaseAdmin().from('impersonation_actions').upsert(
    {
      log_id: session.logId,
      actor_user_id: session.actorUserId,
      account_id: session.accountId,
      method: write.method,
      path: write.path,
      source: 'http',
      request_id: write.requestId,
    },
    { onConflict: 'request_id', ignoreDuplicates: true }
  );
  if (error) {
    console.error('[support-actions] could not record the action:', error);
    return false;
  }
  return true;
}

/**
 * Stamp the outcome on this request's row when the server itself refuses
 * the action (`requireRole` below the effective `admin`, or a route a
 * support session may not use). Best effort: the refusal happens either
 * way, and the row already says the attempt was made.
 */
export async function markSupportActionStatus(
  session: SupportActionSession,
  status: number
): Promise<void> {
  const write = await readSupportWrite();
  if (!write) return;
  const { error } = await supabaseAdmin()
    .from('impersonation_actions')
    .update({ status })
    .eq('request_id', write.requestId)
    .eq('account_id', session.accountId)
    .eq('log_id', session.logId);
  if (error) {
    console.error('[support-actions] could not stamp the status:', error);
  }
}
