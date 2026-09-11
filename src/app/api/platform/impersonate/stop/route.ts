import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { clearSupportCookie } from '@/lib/auth/impersonation';
import {
  closeImpersonationLog,
  readCurrentSession,
} from '@/lib/auth/impersonation-log';
import { requirePlatformAdmin } from '@/lib/auth/platform';

/**
 * POST /api/platform/impersonate/stop — leave the support session.
 *
 * Closes the bitácora row (`ended_at`, `ended_reason`) and drops the
 * cookie, in that order: the audit trail is written before the access is
 * given up, so a failure between the two leaves a logged session rather
 * than an unlogged one.
 *
 * Platform admins only, like the rest of `/api/platform/*`. That is not
 * a way to strand someone: the cookie's `maxAge` equals the session TTL,
 * so an operator whose grant is revoked mid-session stops being able to
 * impersonate on the very next request (`resolveSupportSession` re-checks
 * `platform_admins`) and the cookie itself is gone within the window.
 *
 * Idempotent: no session in force is a 200 with `{ session: null }`, not
 * a 404. The button that calls this is a "get me out of here" button.
 */
export async function POST() {
  try {
    const ctx = await requirePlatformAdmin();
    const { session, expired } = await readCurrentSession();
    const mine = session ?? expired;

    if (mine && mine.actorUserId === ctx.userId) {
      await closeImpersonationLog(mine, session ? 'manual' : 'expired');
    }

    await clearSupportCookie();
    return NextResponse.json({ session: null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
