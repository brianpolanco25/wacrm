// What a support session may change, in a module with NO imports on
// purpose: `src/middleware.ts` (Edge), the browser client
// (`@/lib/supabase/client`) and the server (`resolveSupportSession`) all
// need the same answer, and none of them may drag the others' runtime in.
//
// s9.5 (spec fase 9, decisión 1 del humano): a support session WRITES,
// with effective role `admin`, and every write is recorded in
// `impersonation_actions`. Three layers agree on what that means:
//
//   RLS (migration 072)   `can_write_account()` on the write policies of
//                         the tables below — the only layer that sees the
//                         writes the browser sends straight to PostgREST.
//   middleware            lets a mutating /api request through and tags it
//                         so the server can record it; refuses the short
//                         list of routes a support session must never
//                         reach (`supportWriteVerdict`).
//   browser client        refuses writes to any table NOT below before
//                         they leave the browser (`guardReadOnly`).

/**
 * Tables a support session writes, exactly the ones whose write policies
 * migration 072 moved to `can_write_account` (25 at the time of writing;
 * `support-session-view.test.ts` ties this list to the migration).
 */
export const SUPPORT_WRITABLE_TABLES: ReadonlySet<string> = new Set([
  'ai_configs',
  'ai_knowledge_chunks',
  'ai_knowledge_documents',
  'automation_steps',
  'automations',
  'broadcast_recipients',
  'broadcasts',
  'contact_custom_values',
  'contact_notes',
  'contact_tags',
  'contacts',
  'conversations',
  'custom_fields',
  'deals',
  'flow_nodes',
  'flows',
  'message_reactions',
  'message_templates',
  'messages',
  'pipeline_stages',
  'pipelines',
  'quick_replies',
  'tags',
  'webhook_endpoints',
  'whatsapp_config',
]);

/**
 * Tables migration 072 deliberately leaves closed to a support session.
 * Mirrors the `excluded` array of the migration (the test checks it).
 *
 *   accounts                  ownership row; rename / currency are not
 *                             an `admin`-for-support matter.
 *   account_invitations       an invitation outlives the 30-minute session.
 *   api_keys                  a permanent credential the operator would see.
 *   subscriptions,
 *   checkout_intents          the customer's billing and PayPal.
 *   platform_admins,
 *   impersonation_log,
 *   impersonation_actions     the platform and its audit trail.
 *   profiles, notifications   keyed by `auth.uid()`: during a session they
 *                             are the OPERATOR'S own rows under the
 *                             customer's banner.
 */
export const SUPPORT_REFUSED_TABLES: ReadonlySet<string> = new Set([
  'accounts',
  'account_invitations',
  'api_keys',
  'subscriptions',
  'checkout_intents',
  'platform_admins',
  'impersonation_log',
  'impersonation_actions',
  'profiles',
  'notifications',
]);

/**
 * Request headers the middleware sets on a mutating request that carries a
 * support cookie, so that `resolveSupportSession` can record it. The
 * middleware ALWAYS strips whatever the client sent under these names
 * first: they are only ever the middleware's word.
 *
 * They grant nothing. The server records an action only after the cookie's
 * signature, expiry, actor and bitácora row have all been verified; a
 * forged header on a request with no valid session records nothing.
 */
export const SUPPORT_WRITE_METHOD_HEADER = 'x-wacrm-support-method';
export const SUPPORT_WRITE_PATH_HEADER = 'x-wacrm-support-path';
export const SUPPORT_WRITE_REQUEST_HEADER = 'x-wacrm-support-request';

export const SUPPORT_WRITE_HEADERS = [
  SUPPORT_WRITE_METHOD_HEADER,
  SUPPORT_WRITE_PATH_HEADER,
  SUPPORT_WRITE_REQUEST_HEADER,
] as const;

export type SupportWriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

export function isMutatingMethod(method: string): method is SupportWriteMethod {
  return MUTATING_METHODS.has(method);
}

/**
 * Paths a support session never interferes with, even though the cookie is
 * on the request — neither blocked nor recorded here.
 *
 *   /api/platform/           the operator's own prefix: the exit button,
 *                            and panel acts with their own bitácora. The
 *                            one exception is starting ANOTHER session,
 *                            below.
 *   /api/whatsapp/webhook    CP11: nothing may stop an inbound message.
 *   /api/v1/                 public API, API-key auth, no cookies.
 *   crons                    shared-secret sweeps, no cookies.
 */
const SUPPORT_SESSION_EXEMPT = [
  '/api/platform/',
  '/api/whatsapp/webhook',
  '/api/v1/',
  '/api/automations/cron',
  '/api/flows/cron',
  '/api/webhooks/cron',
];

/**
 * Mutating routes a support session must never reach, whatever the role.
 * Prefixes end in `/` or are matched exactly (see `matches`).
 *
 *   /api/billing/                    checkout and the customer's PayPal
 *                                    subscription.
 *   /api/account (exact)             renames the account (`accounts` is
 *                                    closed at the RLS as well).
 *   /api/account/transfer-ownership  owner-only.
 *   /api/account/members             role changes and removals go through
 *                                    RPCs that resolve the account from
 *                                    `auth.uid()` — during a session that
 *                                    is the OPERATOR'S company.
 *   /api/account/invitations         access that outlives the session.
 *   /api/account/api-keys            a permanent credential.
 *   /api/invitations/                redeeming moves the OPERATOR'S own
 *                                    profile into another company.
 *   /api/platform/impersonate (exact) no nested sessions: exit first.
 *                                    `/stop` stays open.
 */
const SUPPORT_SESSION_BLOCKED: readonly { path: string; exact?: boolean }[] = [
  { path: '/api/billing/' },
  { path: '/api/account', exact: true },
  { path: '/api/account/transfer-ownership' },
  { path: '/api/account/members' },
  { path: '/api/account/invitations' },
  { path: '/api/account/api-keys' },
  { path: '/api/invitations/' },
  { path: '/api/platform/impersonate', exact: true },
];

function matches(path: string, rule: { path: string; exact?: boolean }) {
  if (rule.exact) return path === rule.path || path === `${rule.path}/`;
  if (rule.path.endsWith('/')) return path.startsWith(rule.path);
  return path === rule.path || path.startsWith(`${rule.path}/`);
}

/**
 * What the middleware does with a request that carries a support cookie.
 *
 *   'pass'    not a mutation, or an exempt path: nothing to do.
 *   'block'   a mutation a support session must never make — refused 403.
 *             This includes every mutation OUTSIDE /api (page POSTs are how
 *             server actions travel, and nothing on that path would record
 *             them).
 *   'record'  a mutation the session may make: it goes through, tagged so
 *             the server records it once the session is verified.
 */
export function supportWriteVerdict(
  method: string,
  path: string
): 'pass' | 'block' | 'record' {
  if (!isMutatingMethod(method)) return 'pass';
  if (SUPPORT_SESSION_BLOCKED.some((rule) => matches(path, rule))) {
    return 'block';
  }
  if (SUPPORT_SESSION_EXEMPT.some((prefix) => path.startsWith(prefix))) {
    return 'pass';
  }
  if (!path.startsWith('/api/')) return 'block';
  return 'record';
}
