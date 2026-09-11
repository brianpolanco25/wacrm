// ============================================================
// What the UI needs to know about a support session.
//
// Read straight from the server in the dashboard layout rather than
// fetched from `/api/platform/impersonate`: the banner has to render for
// the operator on every page, and a client fetch would mean every
// ordinary user's browser asking a platform route it is not allowed to
// call — a 403 per page load, in the console, forever.
// ============================================================

import { getCurrentAccount } from './account';
import { readSupportCookie } from './impersonation';

export interface SupportBanner {
  accountId: string;
  accountName: string;
  /** ISO 8601, for the "until" line. */
  expiresAt: string;
}

/**
 * The support session to announce, or `null`.
 *
 * The cookie check comes first and costs nothing: on the overwhelmingly
 * common path — no support session — this returns before touching the
 * database, so putting it in the layout does not add a query to every
 * dashboard page load.
 *
 * Never throws. A banner that could 500 the whole dashboard would be a
 * worse bug than the one it reports.
 */
export async function supportBanner(): Promise<SupportBanner | null> {
  if (!(await readSupportCookie())) return null;

  try {
    const ctx = await getCurrentAccount();
    if (!ctx.impersonation) return null;
    return {
      accountId: ctx.accountId,
      accountName: ctx.account.name,
      expiresAt: new Date(ctx.impersonation.expiresAt).toISOString(),
    };
  } catch {
    // No session, unresolvable account, deleted target… none of those are
    // a support session worth announcing.
    return null;
  }
}
