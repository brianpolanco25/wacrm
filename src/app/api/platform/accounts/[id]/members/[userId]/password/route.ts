// ============================================================
// POST /api/platform/accounts/[id]/members/[userId]/password — an
// operator sets a member's password by hand.
//
// Body: `{ password, reason }`.
//
// Why it exists: the reset-by-email of Supabase is capped (email rate
// limit) and a customer locked out cannot wait for the cap. This goes
// through the Auth admin API and sends nothing.
//
// Same rules as the other acts of the panel:
//   - the bitácora row (`password_set`) goes FIRST; if it cannot be
//     written, the password is not touched;
//   - the reason has the minimum length of the trail;
//   - the person must belong to THIS company (`findMemberForPasswordChange`
//     filters by account), so the URL cannot reach someone else's user;
//   - another operator's password is refused (409).
//
// The log keeps who, whom and why — never the password.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { loadAccountSummary } from '@/lib/platform/accounts';
import { MIN_REASON_LENGTH, recordPlatformAction } from '@/lib/platform/audit';
import {
  findMemberForPasswordChange,
  OPERATOR_MAX_PASSWORD_LENGTH,
  OPERATOR_MIN_PASSWORD_LENGTH,
  setMemberPassword,
} from '@/lib/platform/provisioning';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; userId: string }> }
) {
  let ctx;
  try {
    ctx = await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    throw err;
  }

  try {
    const limit = checkRateLimit(
      `platform:password:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id, userId } = await context.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(userId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      password?: unknown;
      reason?: unknown;
    } | null;

    const password = typeof body?.password === 'string' ? body.password : '';
    if (
      password.length < OPERATOR_MIN_PASSWORD_LENGTH ||
      password.length > OPERATOR_MAX_PASSWORD_LENGTH
    ) {
      return NextResponse.json(
        {
          error: `password must be ${OPERATOR_MIN_PASSWORD_LENGTH} to ${OPERATOR_MAX_PASSWORD_LENGTH} characters`,
          code: 'invalid_password',
        },
        { status: 400 }
      );
    }
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH) {
      return NextResponse.json(
        {
          error: `reason is required and must be at least ${MIN_REASON_LENGTH} characters`,
        },
        { status: 400 }
      );
    }

    const account = await loadAccountSummary(id);
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const member = await findMemberForPasswordChange(id, userId);
    if (!member) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const logged = await recordPlatformAction({
      action: 'password_set',
      actorUserId: ctx.userId,
      accountId: id,
      accountName: account.name,
      reason,
      details: { target_user_id: member.userId, email: member.email },
    });
    if (!logged) {
      return NextResponse.json(
        { error: 'Could not record the action; nothing was changed' },
        { status: 500 }
      );
    }

    const outcome = await setMemberPassword({ userId, password });
    if (!outcome.ok) {
      if (outcome.reason === 'operator') {
        return NextResponse.json(
          {
            error: "An operator's password cannot be set from a company file",
            code: 'is_operator',
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: 'Failed to set the password' },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, userId });
  } catch (err) {
    console.error(
      '[POST /api/platform/accounts/[id]/members/[userId]/password] failed:',
      err
    );
    return NextResponse.json(
      { error: 'Failed to set the password' },
      { status: 500 }
    );
  }
}
