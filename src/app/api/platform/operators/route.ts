// ============================================================
// GET  /api/platform/operators — who operates the platform (s9.4).
// POST /api/platform/operators — grant the role to an existing user.
//
// `platform_admins` has no client write policy (055) and keeps having
// none: every write goes through `platform_grant_operator()` /
// `platform_revoke_operator()` (071), granted to `service_role` only,
// which write the bitácora line and the row in ONE transaction.
//
// POST body: `{ email, note }`. `note` is the reason of the bitácora and
// the `note` of the row: at least ten characters, like every reason.
// The user must already exist — the panel does not create operators
// out of thin air: 404 «primero debe registrarse».
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { MIN_REASON_LENGTH } from '@/lib/platform/audit';
import {
  findProfileByEmail,
  grantOperator,
  listOperators,
  normalizeEmail,
} from '@/lib/platform/provisioning';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    return NextResponse.json({
      operators: await listOperators(),
      // So the page can hide «revoke» on the operator's own row.
      currentUserId: ctx.userId,
    });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    console.error('[GET /api/platform/operators] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the operators' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
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

    const body = (await request.json().catch(() => null)) as {
      email?: unknown;
      note?: unknown;
    } | null;

    const email = normalizeEmail(body?.email);
    if (!email) {
      return NextResponse.json(
        { error: "'email' must be a valid email address" },
        { status: 400 }
      );
    }
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    if (note.length < MIN_REASON_LENGTH) {
      return NextResponse.json(
        {
          error: `note is required and must be at least ${MIN_REASON_LENGTH} characters`,
        },
        { status: 400 }
      );
    }

    const person = await findProfileByEmail(email);
    if (!person) {
      return NextResponse.json(
        {
          error:
            'No user has that email. They must sign up first (primero debe registrarse).',
          code: 'user_absent',
        },
        { status: 404 }
      );
    }

    const outcome = await grantOperator({
      userId: person.userId,
      actorUserId: ctx.userId,
      reason: note,
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'exists':
          return NextResponse.json(
            { error: 'That user is already an operator', code: 'exists' },
            { status: 409 }
          );
        case 'user_absent':
          return NextResponse.json(
            {
              error:
                'No user has that email. They must sign up first (primero debe registrarse).',
              code: 'user_absent',
            },
            { status: 404 }
          );
        case 'bad_reason':
          return NextResponse.json(
            {
              error: `note is required and must be at least ${MIN_REASON_LENGTH} characters`,
            },
            { status: 400 }
          );
        default:
          return NextResponse.json(
            { error: 'Failed to grant the role; nothing was changed' },
            { status: 500 }
          );
      }
    }

    return NextResponse.json(
      { userId: person.userId, email: person.email ?? email },
      { status: 201 }
    );
  } catch (err) {
    console.error('[POST /api/platform/operators] failed:', err);
    return NextResponse.json(
      { error: 'Failed to grant the role' },
      { status: 500 }
    );
  }
}
