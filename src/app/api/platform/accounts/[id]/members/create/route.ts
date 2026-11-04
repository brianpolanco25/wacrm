// ============================================================
// POST /api/platform/accounts/[id]/members/create — an operator CREATES
// a member of a company from its file, already confirmed, with a
// password (i12.2, «Crear miembro»).
//
// Body: `{ email, fullName, role, password, reason }`, role one of
// admin / agent / viewer (never `owner`).
//
// Why it exists: the invitation by link (`../route.ts`) gets lost —
// Supabase's email cap, PKCE opened in another browser… — and the person
// never finishes signing up. Here nothing travels: the operator hands the
// password over a safe channel and the person signs in right away.
//
// How (vía A of the spec): it reuses the signup trigger of migration 090
// instead of inventing a second way in.
//   1. the bitácora row (`member_create`, with the operator's reason)
//      goes FIRST; if it cannot be written, nothing happens;
//   2. a short-lived invitation of THIS company is written (the same
//      `account_invitations` row the Members tab writes);
//   3. `auth.admin.createUser` with `email_confirm` and the invitation
//      token in the metadata: `handle_new_user()` (090) makes the person
//      a member of this company with that role and accepts the
//      invitation, in the signup's transaction — no company of their own,
//      and the seat is checked again there, under a lock;
//   4. if the signup does not happen, the invitation is deleted so it
//      stops holding a seat.
//
// Who already exists is refused (409) and pointed to the existing paths:
// a member of this company → «Cambiar contraseña»; anybody else with that
// email (another company, or an Auth user with no profile) → the
// invitation by link, «Añadir miembro»; a platform operator → never.
//
// The password goes to Supabase and nowhere else: not to the log, not to
// any response, not to any console line.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { generateInviteToken, inviteExpiresAt } from '@/lib/auth/invitations';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { isPlatformAdmin } from '@/lib/auth/platform-admins';
import {
  assertStockLimit,
  getEntitlements,
  PlanLimitError,
} from '@/lib/billing/enforce';
import { loadAccountSummary } from '@/lib/platform/accounts';
import { MIN_REASON_LENGTH, recordPlatformAction } from '@/lib/platform/audit';
import {
  countSeats,
  createConfirmedMember,
  deleteInvitation,
  findProfileByEmail,
  insertInvitation,
  MAX_MEMBER_NAME_LENGTH,
  normalizeEmail,
  OPERATOR_MAX_PASSWORD_LENGTH,
  OPERATOR_MIN_PASSWORD_LENGTH,
} from '@/lib/platform/provisioning';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The invitation only lives for the length of the signup. */
const CREATE_INVITE_EXPIRY_DAYS = 1;

type MemberRole = 'admin' | 'agent' | 'viewer';

function isMemberRole(value: unknown): value is MemberRole {
  return value === 'admin' || value === 'agent' || value === 'viewer';
}

function badRequest(code: string, error: string) {
  return NextResponse.json({ error, code }, { status: 400 });
}

function conflict(code: string, error: string) {
  return NextResponse.json({ error, code }, { status: 409 });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
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

  // Set once the invitation exists, so every way out can delete it.
  let pending: { accountId: string; invitationId: string } | null = null;

  try {
    // The same bucket as the invitation: both add people to a company.
    const limit = checkRateLimit(
      `platform:member:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      email?: unknown;
      fullName?: unknown;
      role?: unknown;
      password?: unknown;
      reason?: unknown;
    } | null;

    const email = normalizeEmail(body?.email);
    if (!email) {
      return badRequest(
        'invalid_email',
        "'email' must be a valid email address"
      );
    }
    const fullName =
      typeof body?.fullName === 'string' ? body.fullName.trim() : '';
    if (!fullName || fullName.length > MAX_MEMBER_NAME_LENGTH) {
      return badRequest(
        'invalid_name',
        `'fullName' is required, up to ${MAX_MEMBER_NAME_LENGTH} characters`
      );
    }
    const role = body?.role;
    if (!isMemberRole(role)) {
      return badRequest(
        'invalid_role',
        "'role' must be one of admin, agent, viewer"
      );
    }
    // Used as typed: a password is not trimmed.
    const password = typeof body?.password === 'string' ? body.password : '';
    if (
      password.length < OPERATOR_MIN_PASSWORD_LENGTH ||
      password.length > OPERATOR_MAX_PASSWORD_LENGTH
    ) {
      return badRequest(
        'invalid_password',
        `password must be ${OPERATOR_MIN_PASSWORD_LENGTH} to ${OPERATOR_MAX_PASSWORD_LENGTH} characters`
      );
    }
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH) {
      return badRequest(
        'invalid_reason',
        `reason is required and must be at least ${MIN_REASON_LENGTH} characters`
      );
    }

    const account = await loadAccountSummary(id);
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const existing = await findProfileByEmail(email);
    if (existing) {
      if (existing.accountId === id) {
        return conflict(
          'already_member',
          'That person is already a member of this company'
        );
      }
      if (await isPlatformAdmin(existing.userId)) {
        return conflict(
          'is_operator',
          'That email belongs to a platform operator'
        );
      }
      // Neither the company nor the user id: the operator only learns
      // that the email is taken, and the invitation is the way.
      return conflict('email_exists', 'That email already has an account');
    }

    assertStockLimit(
      await getEntitlements(id),
      'operators',
      await countSeats(id)
    );

    const logged = await recordPlatformAction({
      action: 'member_create',
      actorUserId: ctx.userId,
      accountId: id,
      accountName: account.name,
      reason,
      details: { email, role, full_name: fullName },
    });
    if (!logged) {
      return NextResponse.json(
        { error: 'Could not record the action; nothing was changed' },
        { status: 500 }
      );
    }

    const { token, hash } = generateInviteToken();
    const invitation = await insertInvitation({
      accountId: id,
      tokenHash: hash,
      role,
      createdBy: ctx.userId,
      label: email,
      expiresAt: inviteExpiresAt(CREATE_INVITE_EXPIRY_DAYS),
    });
    pending = { accountId: id, invitationId: invitation.id };

    const outcome = await createConfirmedMember({
      email,
      password,
      fullName,
      inviteToken: token,
    });

    if (!outcome.ok) {
      await deleteInvitation(id, invitation.id);
      pending = null;
      if (outcome.reason === 'exists') {
        return conflict('email_exists', 'That email already has an account');
      }
      if (outcome.reason === 'rejected') {
        return conflict(
          'rejected',
          'The signup was refused: no free seat or the invitation is gone'
        );
      }
      return NextResponse.json(
        { error: 'Failed to create the member', code: 'create_failed' },
        { status: 502 }
      );
    }

    return NextResponse.json(
      { member: { userId: outcome.userId, email, fullName, role } },
      { status: 201 }
    );
  } catch (err) {
    if (pending) {
      await deleteInvitation(pending.accountId, pending.invitationId);
    }
    if (err instanceof PlanLimitError) return toErrorResponse(err);
    // The error only: the request body carries the password.
    console.error(
      '[POST /api/platform/accounts/[id]/members/create] failed:',
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { error: 'Failed to create the member' },
      { status: 500 }
    );
  }
}
