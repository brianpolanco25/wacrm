// ============================================================
// /api/account/invitations
//
//   GET  — list outstanding (un-redeemed, non-expired) invites.
//   POST — create a new invite link.
//
// Both admin+. The list endpoint is what the Members tab uses to
// populate the "Pending invitations" section; create is what the
// "Invite member" dialog calls.
//
// IMPORTANT: the plaintext token is returned exactly ONCE — in
// the POST response. We store only the SHA-256 hash on the row,
// so neither GET nor a future PATCH can ever resurface the
// link. The admin sees it in the creation modal, copies it, and
// shares it via WhatsApp/Slack/whatever they like. If they
// dismiss the modal without copying, the only recourse is to
// revoke and re-issue.
// ============================================================

import { NextResponse } from "next/server";

import { assertNotSupportSession, requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  clampExpiryDays,
  generateInviteToken,
  inviteExpiresAt,
  inviteUrl,
  resolveInviteBaseUrl,
} from "@/lib/auth/invitations";
import { isAccountRole } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { assertStockLimit, getEntitlements } from "@/lib/billing/enforce";

// The base URL of the invite link (`NEXT_PUBLIC_SITE_URL`, then the proxy
// headers validated against `ALLOWED_INVITE_HOSTS`, then the Host) lives in
// `resolveInviteBaseUrl` (`src/lib/auth/invitations.ts`), shared with the
// platform panel's «Añadir miembro» (s9.4) so both links resolve alike.

const MAX_LABEL_LEN = 80;

export async function GET() {
  try {
    // `allowReadOnly`: a read. Fase 3 §5 drops every member of a locked
    // account to `viewer`, and a viewer can look at the team — refusing
    // this GET would black out the invitations list of any account
    // whose subscription lapsed, which §5 never asked for.
    const ctx = await requireRole("admin", { allowReadOnly: true });

    const { data, error } = await ctx.supabase
      .from("account_invitations")
      .select(
        "id, role, label, created_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id",
      )
      .eq("account_id", ctx.accountId)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[GET /api/account/invitations] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load invitations" },
        { status: 500 },
      );
    }

    return NextResponse.json({ invitations: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    // s9.5: never during a support session, whatever the role.
    await assertNotSupportSession(ctx);

    // 30/min per user. The Members tab is a clicks-only UI so any
    // legitimate admin is far below this; the cap exists to keep
    // a script run in a loop or a compromised admin session from
    // flooding `account_invitations` with rows.
    const limit = checkRateLimit(
      `admin:inviteCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown; expiresInDays?: unknown; label?: unknown }
      | null;

    const role = body?.role;
    if (!isAccountRole(role) || role === "owner") {
      // The DB CHECK already rejects 'owner', but failing fast
      // here gives a clearer 400 than the eventual constraint
      // violation surfaced as a 500.
      return NextResponse.json(
        { error: "'role' must be one of admin, agent, viewer" },
        { status: 400 },
      );
    }

    const expiresInDaysRaw = body?.expiresInDays;
    // `clampExpiryDays` tolerates undefined / NaN / negatives by
    // collapsing to the safe default, so we just pass the raw
    // value through after a type narrow.
    const expiresInDays =
      typeof expiresInDaysRaw === "number" ? expiresInDaysRaw : undefined;
    const expiryDays = clampExpiryDays(expiresInDays);
    const expiresAt = inviteExpiresAt(expiryDays);

    let label: string | null = null;
    if (typeof body?.label === "string") {
      const trimmed = body.label.trim();
      if (trimmed.length > MAX_LABEL_LEN) {
        return NextResponse.json(
          { error: `Label must be ${MAX_LABEL_LEN} characters or fewer` },
          { status: 400 },
        );
      }
      label = trimmed === "" ? null : trimmed;
    }

    // Fase 3 §4: `operators`. A seat is a seat whether it is already
    // occupied or merely promised, so the headcount is members PLUS
    // outstanding invitations — otherwise an admin on a 3-seat plan
    // issues ten links and lets the limit be discovered by whoever
    // redeems the fourth, when there is no polite way to refuse them.
    //
    // This is a STOCK limit: it is counted live, not accumulated in
    // `usage_counters`. Removing a member gives the seat back, and a
    // monotonic counter could never express that.
    const entitlements = await getEntitlements(ctx.accountId);
    const [
      { count: memberCount, error: memberErr },
      { count: pendingCount, error: pendingErr },
    ] = await Promise.all([
      ctx.supabase
        .from("profiles")
        .select("user_id", { count: "exact", head: true })
        .eq("account_id", ctx.accountId),
      ctx.supabase
        .from("account_invitations")
        .select("id", { count: "exact", head: true })
        .eq("account_id", ctx.accountId)
        .is("accepted_at", null)
        .gt("expires_at", new Date().toISOString()),
    ]);

    if (memberErr || pendingErr) {
      // Fail closed: a headcount we could not take must not read as
      // "zero seats used" and hand out an unlimited number of links.
      console.error("[POST /api/account/invitations] seat count error:", {
        memberErr,
        pendingErr,
      });
      return NextResponse.json(
        { error: "Failed to check the seat limit" },
        { status: 500 },
      );
    }

    assertStockLimit(
      entitlements,
      "operators",
      (memberCount ?? 0) + (pendingCount ?? 0),
    );

    const { token, hash } = generateInviteToken();

    const { data, error } = await ctx.supabase
      .from("account_invitations")
      .insert({
        account_id: ctx.accountId,
        token_hash: hash,
        role,
        created_by_user_id: ctx.userId,
        label,
        expires_at: expiresAt.toISOString(),
      })
      .select("id, role, label, expires_at, created_at")
      .single();

    if (error || !data) {
      console.error("[POST /api/account/invitations] insert error:", error);
      return NextResponse.json(
        { error: "Failed to create invitation" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        invitation: data,
        // Plaintext payload — visible to the admin exactly once.
        token,
        url: inviteUrl(token, resolveInviteBaseUrl(request)),
        expiresInDays: expiryDays,
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
