// ============================================================
// GET  /api/platform/accounts — the census (fase 4 §2, «Listado de
// cuentas»).
// POST /api/platform/accounts — create a company (s9.4, «Crear
// empresa»); see the comment above `POST`.
//
// Name, plan, subscription state, members, consumption of the cycle,
// signup date and last activity, for every account of the service.
//
// `requirePlatformAdmin()` first, as on every route of this prefix. A
// company `owner` is exactly as unwelcome here as a `viewer`: owning a
// company is not operating the platform, and the spec forbids conflating
// the two outright. This is THE route the acceptance criterion «un
// administrador de plataforma ve todas las cuentas; un `owner` normal no
// ve más que la suya» is graded on, and its 403 leaks nothing.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { resolveAppOrigin } from '@/lib/billing/checkout';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  listAccounts,
} from '@/lib/platform/accounts';
import {
  attachAccountToAuditRow,
  MIN_REASON_LENGTH,
  recordPlatformAction,
} from '@/lib/platform/audit';
import {
  findAccountOwnedBy,
  findProfileByEmail,
  inviteAuthUser,
  MAX_ACCOUNT_NAME_LENGTH,
  normalizeEmail,
  overridePlan,
  planExists,
  renameAccount,
} from '@/lib/platform/provisioning';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

function intParam(value: string | null, fallback: number): number {
  if (value === null || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin();

    const url = new URL(request.url);
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, intParam(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE))
    );
    const offset = Math.max(0, intParam(url.searchParams.get('offset'), 0));

    return NextResponse.json(
      await listAccounts({
        search: url.searchParams.get('q'),
        limit,
        offset,
      })
    );
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    console.error('[GET /api/platform/accounts] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the account list' },
      { status: 500 }
    );
  }
}

// ------------------------------------------------------------
// POST — create a company
//
// Body: `{ name, ownerEmail, ownerName?, planId?, reason }`.
//
// There is no "create an account" in this schema: a company is born
// with its owner (`accounts.owner_user_id` is NOT NULL and points at
// `auth.users`), from `handle_new_user()` (017). So the panel invites
// the owner through Supabase — which creates the auth user at once and
// fires that trigger — and then renames the company it created and,
// optionally, gives it a plan by hand. `handle_new_user()` and
// `redeem_invitation()` are untouched.
//
// Order, and why:
//   1. validation, and 409 if the email already has a user (the invite
//      would fail anyway; this says so before anything is written);
//   2. the bitácora row (`account_create`, no account yet — migration
//      071 allows exactly that) — BEFORE the act, as `[id]/hold`;
//   3. the invite; 4. the account id into the log row; 5. the rename;
//   6. the plan, through the same `overridePlan` as the file (its own
//      `plan_override` line).
// ------------------------------------------------------------

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
      `platform:provision:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      ownerEmail?: unknown;
      ownerName?: unknown;
      planId?: unknown;
      reason?: unknown;
    } | null;

    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_ACCOUNT_NAME_LENGTH) {
      return NextResponse.json(
        {
          error: `'name' is required and must be at most ${MAX_ACCOUNT_NAME_LENGTH} characters`,
        },
        { status: 400 }
      );
    }

    const email = normalizeEmail(body?.ownerEmail);
    if (!email) {
      return NextResponse.json(
        { error: "'ownerEmail' must be a valid email address" },
        { status: 400 }
      );
    }

    const ownerName =
      typeof body?.ownerName === 'string' && body.ownerName.trim()
        ? body.ownerName.trim().slice(0, MAX_ACCOUNT_NAME_LENGTH)
        : null;

    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH) {
      return NextResponse.json(
        {
          error: `reason is required and must be at least ${MIN_REASON_LENGTH} characters`,
        },
        { status: 400 }
      );
    }

    let planId: string | null = null;
    if (
      body?.planId !== undefined &&
      body?.planId !== null &&
      body.planId !== ''
    ) {
      if (typeof body.planId !== 'string' || !(await planExists(body.planId))) {
        return NextResponse.json({ error: 'Unknown plan' }, { status: 400 });
      }
      planId = body.planId;
    }

    if (await findProfileByEmail(email)) {
      return NextResponse.json(
        {
          error:
            'That email already has a user. Add them to a company from its file instead.',
          code: 'email_exists',
        },
        { status: 409 }
      );
    }

    const logId = await recordPlatformAction({
      action: 'account_create',
      actorUserId: ctx.userId,
      accountId: null,
      accountName: name,
      reason,
      details: { owner_email: email, owner_name: ownerName, plan_id: planId },
    });
    if (!logId) {
      return NextResponse.json(
        { error: 'Could not record the action; nothing was changed' },
        { status: 500 }
      );
    }

    const invited = await inviteAuthUser({
      email,
      fullName: ownerName,
      redirectTo: `${resolveAppOrigin(request)}/login`,
    });
    if (!invited.ok) {
      return invited.reason === 'exists'
        ? NextResponse.json(
            {
              error:
                'That email already has a user. Add them to a company from its file instead.',
              code: 'email_exists',
            },
            { status: 409 }
          )
        : NextResponse.json(
            { error: 'Could not send the invitation; nothing was created' },
            { status: 502 }
          );
    }

    const account = await findAccountOwnedBy(invited.userId);
    if (!account) {
      // `handle_new_user()` swallows its own failures (017): the user
      // exists and was emailed, but has no company. Said out loud.
      console.error(
        '[POST /api/platform/accounts] invited user has no account:',
        invited.userId
      );
      return NextResponse.json(
        {
          error:
            'The owner was invited but their company was not created; check the database',
          userId: invited.userId,
        },
        { status: 500 }
      );
    }

    await attachAccountToAuditRow(logId, account.id);
    await renameAccount(account.id, name);

    let planError: string | null = null;
    if (planId) {
      const outcome = await overridePlan({
        accountId: account.id,
        accountName: name,
        planId,
        actorUserId: ctx.userId,
        reason,
      });
      if (!outcome.ok) planError = outcome.reason;
    }

    return NextResponse.json(
      {
        accountId: account.id,
        userId: invited.userId,
        name,
        planId: planError ? null : planId,
        ...(planError ? { planError } : {}),
      },
      { status: 201 }
    );
  } catch (err) {
    console.error('[POST /api/platform/accounts] failed:', err);
    return NextResponse.json(
      { error: 'Failed to create the company' },
      { status: 500 }
    );
  }
}
