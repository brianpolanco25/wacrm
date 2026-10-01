import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import {
  DEFAULT_SUPPORT_REASON,
  MIN_REASON_LENGTH,
  SUPPORT_SESSION_TTL_MS,
  clearSupportCookie,
  setSupportCookie,
  signSupportSession,
  type SupportSession,
} from '@/lib/auth/impersonation';
import {
  closeImpersonationLog,
  readCurrentSession,
  sessionView,
} from '@/lib/auth/impersonation-log';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  supersedeOpenSupportSessions,
  sweepExpiredSupportSessions,
} from '@/lib/auth/support-session-store';

// ============================================================
// /api/platform/impersonate — open and inspect a support session.
//
// `/api/platform/*` is the operator's own prefix, with its own guard
// (`requirePlatformAdmin`). Nothing in this tree consults
// `account_role_enum`: a company `owner` is exactly as unwelcome here as
// a `viewer`, and both get 403.
//
// Every open and every close writes to `impersonation_log`. Without that
// bitácora, impersonation is a back door — the spec's own wording.
// ============================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET /api/platform/impersonate — the support session in force, if any.
 *
 * Platform admins only. Also where an expired session's bitácora row gets
 * closed, so `ended_at` reflects reality without a scheduled sweep.
 */
export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    // Close whatever ran out of time, whoever opened it. See
    // `sweepExpiredSupportSessions` for why the sweep lives on this route
    // instead of in a cron.
    await sweepExpiredSupportSessions();
    const { session, expired } = await readCurrentSession();

    if (expired) {
      if (expired.actorUserId === ctx.userId) {
        await closeImpersonationLog(expired, 'expired');
      }
      await clearSupportCookie();
      return NextResponse.json({ session: null });
    }
    // A cookie naming somebody else is not this operator's session; it
    // grants nothing (`resolveSupportSession` refuses it too) and is not
    // reported as theirs either.
    if (!session || session.actorUserId !== ctx.userId) {
      return NextResponse.json({ session: null });
    }

    // The impersonated account, read with the service role and filtered by
    // its primary key — which on `accounts` IS the account scope. The id
    // comes from the signed cookie, never from the request.
    const { data: account } = await supabaseAdmin()
      .from('accounts')
      .select('id, name')
      .eq('id', session.accountId)
      .maybeSingle();

    return NextResponse.json({
      session: sessionView(session, (account?.name as string | null) ?? null),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/platform/impersonate — open a support session.
 *
 * Body: `{ account_id, reason? }`. The reason is optional (s9.12): when it
 * is missing or blank the row records `DEFAULT_SUPPORT_REASON`, so the
 * bitácora still says who opened what, when, and until when. A reason that
 * IS written must still reach the minimum length — three letters in that
 * column read like an explanation and explain nothing, which is worse than
 * the honest default.
 */
export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requirePlatformAdmin();
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const accountId = typeof body.account_id === 'string' ? body.account_id : '';
  if (!UUID_RE.test(accountId)) {
    return NextResponse.json(
      { error: 'account_id must be a UUID' },
      { status: 400 }
    );
  }

  const written = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (written.length > 0 && written.length < MIN_REASON_LENGTH) {
    return NextResponse.json(
      {
        error: `reason, when given, must be at least ${MIN_REASON_LENGTH} characters`,
      },
      { status: 400 }
    );
  }
  const reason = written || DEFAULT_SUPPORT_REASON;

  const admin = supabaseAdmin();

  const { data: account, error: accountErr } = await admin
    .from('accounts')
    .select('id, name')
    .eq('id', accountId)
    .maybeSingle();

  if (accountErr) {
    console.error('[platform/impersonate] account lookup failed:', accountErr);
    return NextResponse.json(
      { error: 'Failed to start session' },
      { status: 500 }
    );
  }
  if (!account) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Rows nobody will ever come back to close (the operator who shut the
  // browser instead of pressing exit) get closed here, on the rare path
  // that only platform operators reach.
  await sweepExpiredSupportSessions();

  // Re-opening while one is already open closes the previous row first, so
  // the bitácora never shows two overlapping sessions for one operator.
  const { session: previous, expired } = await readCurrentSession();
  if (previous && previous.actorUserId === ctx.userId) {
    await closeImpersonationLog(previous, 'superseded');
  } else if (expired && expired.actorUserId === ctx.userId) {
    await closeImpersonationLog(expired, 'expired');
  }

  // …and every other session this operator still has open, in ANY browser
  // (s9.5). With two open rows the audit could not tell which session a
  // write belonged to, and migration 072 now refuses a second open row
  // outright. No clean slate, no new session.
  if (!(await supersedeOpenSupportSessions(ctx.userId))) {
    return NextResponse.json(
      { error: 'Failed to start session' },
      { status: 500 }
    );
  }

  const now = Date.now();
  const session: SupportSession = {
    logId: randomUUID(),
    actorUserId: ctx.userId,
    accountId,
    expiresAt: now + SUPPORT_SESSION_TTL_MS,
  };

  // The bitácora row is written BEFORE the cookie. If the insert fails
  // there is no session: an unlogged impersonation is the single outcome
  // this feature exists to prevent.
  const { error: logErr } = await admin.from('impersonation_log').insert({
    id: session.logId,
    // Written out rather than left to the column default of migration
    // 058: this bitácora now holds suspend and reactivate rows too, and
    // everything that reads a session filters on this value.
    action: 'impersonation',
    actor_user_id: ctx.userId,
    account_id: accountId,
    account_name: (account.name as string | null) ?? null,
    reason,
    started_at: new Date(now).toISOString(),
    expires_at: new Date(session.expiresAt).toISOString(),
  });

  if (logErr) {
    console.error('[platform/impersonate] audit insert failed:', logErr);
    return NextResponse.json(
      { error: 'Could not record the impersonation; session not started' },
      { status: 500 }
    );
  }

  // Signing and handing out the cookie are the only steps left, and they
  // are the ones that can still throw: `signingKey()` refuses a missing or
  // malformed `ENCRYPTION_KEY`, and `cookies()` can fail outside a request
  // scope. Left uncaught, either would leave a 500 AND a bitácora row open
  // forever — nobody would hold the cookie that names it, so nothing could
  // ever close it. Close it here instead, and report a session that never
  // started as exactly that.
  try {
    await setSupportCookie(
      signSupportSession(session),
      session.expiresAt,
      accountId
    );
  } catch (err) {
    console.error('[platform/impersonate] could not issue the cookie:', err);
    await closeImpersonationLog(session, 'expired');
    return NextResponse.json(
      { error: 'Could not start the session' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    session: sessionView(session, (account.name as string | null) ?? null),
  });
}
