// ============================================================
// POST /api/account/api-keys/[id]/rotate — swap a key without an
// outage (fase 7 §1).
//
// Rotation is the operation that makes "change your credentials
// regularly" survive contact with production. Revoke-then-create has a
// gap in the middle: between the click and the redeploy, every call the
// customer's integration makes 401s. So this does the two halves in one
// step and in the safe order:
//
//   1. mint a NEW key with the SAME name and the SAME scopes,
//   2. stamp the OLD one with `revoked_at = now() + 24 h`.
//
// The old key keeps authenticating for those 24 hours
// (`findActiveKeyByHash` compares `revoked_at` against the clock, not
// against NULL), which is the whole point: the admin deploys the new
// value whenever they can, and the old one dies by itself. An admin who
// is rotating *because the key leaked* does not want to wait — that is
// what `DELETE /api/account/api-keys/[id]` is for, and it accepts a key
// already inside its grace window precisely so it can cut it short.
//
// Order matters: the new key is inserted FIRST. If the stamp on the old
// one then fails we delete the new row and 500, because the failure
// mode we refuse to ship is "two permanently valid keys where the admin
// believes there is one".
//
// What cannot be rotated, and why (fase 7 §1, 2.ª ronda)
//   • a key already revoked, or one whose `expires_at` is in the past →
//     404. Rotating a dead credential would mint a replacement that
//     INHERITS its expiry and therefore never authenticates: the admin
//     would copy a one-time plaintext that is useless from the first
//     second. Replace it with a new key instead.
//   • a key already inside its grace window → 409. The second rotation
//     cannot move the first deadline (that is the point of the `.is`
//     guard below), so all it would do is leave a third row with the
//     same name and a second live credential nobody asked for.
//   Both match what Ajustes → API already offers: the Rotate button
//   only appears on a key whose status is `active`.
//
// Admin+, cookie session, RLS client — same as the rest of
// `/api/account/api-keys`. The plaintext is returned exactly ONCE, as
// on creation.
//
// Body (all optional):
//   { "expiresInDays": 90 }   // omitted → inherit the old key's expiry
//
// Response (201):
//   { "key": { …safe columns… },
//     "plaintext": "wacrm_live_…",
//     "previous": { "id": "…", "revoked_at": "…" } }
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  expiryFromDays,
  generateApiKey,
  ROTATION_GRACE_MS,
} from '@/lib/api-keys/keys';
import { API_KEY_SAFE_COLUMNS } from '@/lib/api-keys/store';
import { assertPlanFeature } from '@/lib/billing/enforce';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    // Same rule as minting: the replacement key would be refused by
    // `/api/v1` on a plan without the `api` feature.
    await assertPlanFeature(ctx.accountId, 'api');

    const limit = checkRateLimit(
      `admin:apiKeyRotate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      expiresInDays?: unknown;
    } | null;

    const now = Date.now();

    // Scoped by account_id as well as id: an admin can never rotate
    // another account's key by guessing a UUID (RLS says the same; the
    // explicit filter makes the 404 path precise).
    const { data: current, error: readError } = await ctx.supabase
      .from('api_keys')
      .select('id, name, scopes, expires_at, revoked_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (readError) {
      console.error(
        '[POST /api/account/api-keys/[id]/rotate] read:',
        readError
      );
      return NextResponse.json(
        { error: 'Failed to rotate API key' },
        { status: 500 }
      );
    }

    const revokedAtMs =
      current?.revoked_at == null
        ? null
        : new Date(current.revoked_at as string).getTime();
    const alreadyDead = revokedAtMs !== null && revokedAtMs <= now;
    const alreadyExpired =
      current?.expires_at != null &&
      new Date(current.expires_at as string).getTime() <= now;

    if (!current || alreadyDead || alreadyExpired) {
      // Dead keys are not rotated, they are replaced: rotating one would
      // resurrect an integration the admin already switched off, or (for
      // an expired one) hand out a replacement that inherits an expiry
      // already in the past.
      return NextResponse.json(
        { error: 'API key not found, expired or already revoked' },
        { status: 404 }
      );
    }

    if (revokedAtMs !== null) {
      // `revoked_at` in the future = this key is already rotating. A
      // second rotation cannot shorten the first deadline and would only
      // add another live credential.
      return NextResponse.json(
        {
          error:
            'API key is already rotating; use the key minted by the first rotation, or revoke this one now',
        },
        { status: 409 }
      );
    }

    // Expiry: an explicit `expiresInDays` wins; otherwise the new key
    // inherits the old one's `expires_at` verbatim. Inheriting rather
    // than silently restarting the clock keeps rotation from being a
    // back door that extends a deliberately short-lived credential.
    const requested = expiryFromDays(body?.expiresInDays);
    const expiresAt =
      requested ?? (current.expires_at as string | null) ?? null;

    const { plaintext, hash, prefix } = generateApiKey();

    const { data: created, error: insertError } = await ctx.supabase
      .from('api_keys')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        // Same name on purpose: the label describes the integration,
        // which has not changed. The prefix tells the two apart in the
        // roster, and the old one is visibly "rotating".
        name: current.name as string,
        key_prefix: prefix,
        key_hash: hash,
        scopes: (current.scopes as string[]) ?? [],
        expires_at: expiresAt,
      })
      .select(API_KEY_SAFE_COLUMNS)
      .single();

    if (insertError || !created) {
      console.error(
        '[POST /api/account/api-keys/[id]/rotate] insert:',
        insertError
      );
      return NextResponse.json(
        { error: 'Failed to rotate API key' },
        { status: 500 }
      );
    }

    const revokedAt = new Date(now + ROTATION_GRACE_MS).toISOString();
    const { data: stamped, error: updateError } = await ctx.supabase
      .from('api_keys')
      .update({ revoked_at: revokedAt })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      // Only a live key gets stamped. The 409 above already rejects a
      // key that was rotating when we read it; this guard covers the
      // race where it entered a grace window in between, and keeps that
      // (earlier) deadline instead of pushing it further out.
      .is('revoked_at', null)
      .select('id, revoked_at')
      .maybeSingle();

    if (updateError) {
      // Undo the new key rather than leave two live credentials.
      await ctx.supabase
        .from('api_keys')
        .delete()
        .eq('id', created.id)
        .eq('account_id', ctx.accountId);
      console.error(
        '[POST /api/account/api-keys/[id]/rotate] stamp:',
        updateError
      );
      return NextResponse.json(
        { error: 'Failed to rotate API key' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        key: created,
        // Plaintext — shown to the admin exactly once.
        plaintext,
        previous: {
          id,
          revoked_at:
            (stamped?.revoked_at as string | null) ??
            (current.revoked_at as string | null) ??
            revokedAt,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
