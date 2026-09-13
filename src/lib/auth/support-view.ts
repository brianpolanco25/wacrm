// ============================================================
// What the UI needs to know about a support session.
//
// Read straight from the server in the dashboard layout rather than
// fetched from `/api/platform/impersonate`: the banner has to render for
// the operator on every page, and a client fetch would mean every
// ordinary user's browser asking a platform route it is not allowed to
// call — a 403 per page load, in the console, forever.
// ============================================================

import { unstable_rethrow } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { getCurrentAccount } from './account';
import { readSupportCookie, resolveSupportSession } from './impersonation';

export interface SupportBanner {
  accountId: string;
  /**
   * `null` when the impersonated account can no longer be read — deleted
   * mid-session, or a database that will not answer. The banner still has
   * to render: it carries the only way out.
   */
  accountName: string | null;
  /** ISO 8601, for the "until" line. */
  expiresAt: string;
}

/**
 * A banner for a session whose account could not be loaded.
 *
 * Without this, a target account deleted mid-session left the operator
 * with a dashboard that 403s everything AND no exit button — the session
 * still in force, nothing on screen admitting it, and half an hour to
 * wait. The warning and the way out are the same control; it has to
 * survive the failure it is warning about.
 */
async function strandedBanner(): Promise<SupportBanner | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const session = await resolveSupportSession(user.id);
  if (!session) return null;

  return {
    accountId: session.accountId,
    accountName: null,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

/**
 * The support session to announce, or `null`.
 *
 * The cookie check comes first and costs nothing: on the overwhelmingly
 * common path — no support session — this returns before touching the
 * database, so putting it in the layout does not add a query to every
 * dashboard page load.
 *
 * Never throws anything of its own. A banner that could 500 the whole
 * dashboard would be a worse bug than the one it reports — but Next's own
 * bail-out signals are re-thrown (`unstable_rethrow`), because swallowing
 * one would prerender the shell with no banner at all.
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
  } catch (err) {
    unstable_rethrow(err);
    // Not "no session": the account context failed. If a session really is
    // in force, say so with no name rather than say nothing.
    try {
      return await strandedBanner();
    } catch (inner) {
      unstable_rethrow(inner);
      return null;
    }
  }
}
