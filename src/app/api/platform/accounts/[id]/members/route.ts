// ============================================================
// POST /api/platform/accounts/[id]/members — invite a member to a
// company from its file (s9.4, «Añadir miembro»).
//
// Body: `{ email, role }`, role one of admin / agent / viewer. Never
// `owner`: the company already has one, and `account_invitations` refuses
// it by CHECK (017).
//
// It REUSES the invitation of the Members tab rather than inventing a
// second way in: the same `account_invitations` row, the same token hash,
// the same `/join/<token>` page and the same `redeem_invitation()`
// (019/049/052) — which is what moves the person into the company and
// cleans up their empty personal one. What changes is who creates it
// (the operator, through the service role, for the company of the file)
// and how the link travels:
//
//   - nobody has that email yet → Supabase emails an invitation whose
//     link lands on `/join/<token>` (`inviteUserByEmail` + `redirectTo`);
//   - somebody does → no email from us (Supabase would refuse to invite
//     an existing user); the link comes back for the operator to share,
//     as the Members tab does;
//   - they are already in THIS company → 409.
//
// The seat limit of the plan applies as in the Members tab (members plus
// outstanding invitations): an operator who wants more seats gives the
// company a bigger plan first, on the same file.
//
// The bitácora row (`member_invite`) goes BEFORE the invitation.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import {
  DEFAULT_INVITE_EXPIRY_DAYS,
  generateInviteToken,
  inviteExpiresAt,
  inviteUrl,
} from '@/lib/auth/invitations';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { resolveAppOrigin } from '@/lib/billing/checkout';
import {
  assertStockLimit,
  getEntitlements,
  PlanLimitError,
} from '@/lib/billing/enforce';
import { loadAccountSummary } from '@/lib/platform/accounts';
import { recordPlatformAction } from '@/lib/platform/audit';
import {
  countSeats,
  findProfileByEmail,
  insertInvitation,
  inviteAuthUser,
  normalizeEmail,
} from '@/lib/platform/provisioning';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MemberRole = 'admin' | 'agent' | 'viewer';

function isMemberRole(value: unknown): value is MemberRole {
  return value === 'admin' || value === 'agent' || value === 'viewer';
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

  try {
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
      role?: unknown;
    } | null;

    const email = normalizeEmail(body?.email);
    if (!email) {
      return NextResponse.json(
        { error: "'email' must be a valid email address" },
        { status: 400 }
      );
    }
    const role = body?.role;
    if (!isMemberRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of admin, agent, viewer" },
        { status: 400 }
      );
    }

    const account = await loadAccountSummary(id);
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const existing = await findProfileByEmail(email);
    if (existing?.accountId === id) {
      return NextResponse.json(
        {
          error: 'That person is already a member of this company',
          code: 'already_member',
        },
        { status: 409 }
      );
    }

    assertStockLimit(
      await getEntitlements(id),
      'operators',
      await countSeats(id)
    );

    const logged = await recordPlatformAction({
      action: 'member_invite',
      actorUserId: ctx.userId,
      accountId: id,
      accountName: account.name,
      // The panel asks for no reason here — inviting someone the company
      // named is routine, unlike a suspension — but the log's CHECK
      // wants ten characters, so the line says what happened.
      reason: `member invite: ${email} as ${role}`,
      details: { email, role, existing_user: Boolean(existing) },
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
      expiresAt: inviteExpiresAt(DEFAULT_INVITE_EXPIRY_DAYS),
    });
    const url = inviteUrl(token, resolveAppOrigin(request));

    let emailed = false;
    if (!existing) {
      const invited = await inviteAuthUser({ email, redirectTo: url });
      emailed = invited.ok;
    }

    return NextResponse.json(
      {
        invitation: {
          id: invitation.id,
          role,
          expiresAt: invitation.expiresAt,
        },
        // Plaintext, exactly once, as in the Members tab: the operator
        // shares it when no email went out.
        url,
        emailed,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof PlanLimitError) return toErrorResponse(err);
    console.error('[POST /api/platform/accounts/[id]/members] failed:', err);
    return NextResponse.json(
      { error: 'Failed to invite the member' },
      { status: 500 }
    );
  }
}
