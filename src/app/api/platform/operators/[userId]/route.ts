// ============================================================
// DELETE /api/platform/operators/[userId] — revoke the operator role
// (s9.4).
//
// Body: `{ reason }` — the bitácora line (`operator_revoke`), at least
// ten characters like every reason of the log.
//
// Two rules, both enforced INSIDE `platform_revoke_operator()` (071)
// under a table lock, and the first also here for a fast answer:
//   - not oneself: 400. An operator who revokes themselves by mistake
//     has nobody to undo it but another operator.
//   - never the last one: 400. A service with no operator can only be
//     recovered with SQL against the database.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { MIN_REASON_LENGTH } from '@/lib/platform/audit';
import { revokeOperator } from '@/lib/platform/provisioning';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: Request,
  context: { params: Promise<{ userId: string }> }
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
      `platform:operator:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await context.params;
    if (!UUID_RE.test(userId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (userId === ctx.userId) {
      return NextResponse.json(
        { error: 'You cannot revoke your own operator role', code: 'self' },
        { status: 400 }
      );
    }

    const body = (await request.json().catch(() => null)) as {
      reason?: unknown;
    } | null;
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH) {
      return NextResponse.json(
        {
          error: `reason is required and must be at least ${MIN_REASON_LENGTH} characters`,
        },
        { status: 400 }
      );
    }

    const outcome = await revokeOperator({
      userId,
      actorUserId: ctx.userId,
      reason,
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'self':
          return NextResponse.json(
            {
              error: 'You cannot revoke your own operator role',
              code: 'self',
            },
            { status: 400 }
          );
        case 'last':
          return NextResponse.json(
            {
              error:
                'This is the last operator; grant the role to someone else first',
              code: 'last',
            },
            { status: 400 }
          );
        case 'absent':
          return NextResponse.json({ error: 'Not found' }, { status: 404 });
        case 'bad_reason':
          return NextResponse.json(
            {
              error: `reason is required and must be at least ${MIN_REASON_LENGTH} characters`,
            },
            { status: 400 }
          );
        default:
          return NextResponse.json(
            { error: 'Failed to revoke the role; nothing was changed' },
            { status: 500 }
          );
      }
    }

    return NextResponse.json({ userId, revoked: true });
  } catch (err) {
    console.error('[DELETE /api/platform/operators/[userId]] failed:', err);
    return NextResponse.json(
      { error: 'Failed to revoke the role' },
      { status: 500 }
    );
  }
}
