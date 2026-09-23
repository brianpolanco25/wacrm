// ============================================================
// /api/account/api-keys
//
//   GET  — list this account's API keys (safe columns only).
//   POST — mint a new key.
//
// These are the *dashboard* endpoints for managing keys, so they
// authenticate the normal way (cookie session) and go through the
// RLS client. Listing is open to any member (viewer+) — the roster
// is not secret; the secret (the key itself) is never in it. Minting
// is admin+ (a key hands out capabilities), enforced by both
// `requireRole('admin')` here and the `api_keys_insert` RLS policy, and
// only on a plan with the `api` feature.
//
// IMPORTANT: the plaintext key is returned exactly ONCE, in the POST
// response. We persist only its SHA-256 hash, so neither GET nor any
// future endpoint can resurface it — same one-time-reveal contract
// as invite links. If the admin loses it, they revoke and re-issue.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { expiryFromDays, generateApiKey } from '@/lib/api-keys/keys';
import { API_KEY_SAFE_COLUMNS } from '@/lib/api-keys/store';
import { readJsonBody } from '@/lib/api/v1/body';
import { normalizeScopes } from '@/lib/api-keys/scopes';
import { assertPlanFeature } from '@/lib/billing/enforce';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MAX_NAME_LEN = 80;

export async function GET() {
  try {
    // Any member can view the roster (RLS allows it); we just need a
    // resolved account context.
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('api_keys')
      .select(API_KEY_SAFE_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/account/api-keys] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load API keys' },
        { status: 500 }
      );
    }

    return NextResponse.json({ keys: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    // A key is only useful on a plan with the `api` feature (Pro and
    // Negocio, migration 065): `/api/v1` refuses it otherwise. Refuse
    // the mint too, so an Inicio admin learns it here with the upgrade
    // hint instead of from a 402 in their integration.
    await assertPlanFeature(ctx.accountId, 'api');

    const limit = checkRateLimit(
      `admin:apiKeyCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Capped read (1 MiB → 413, wrong media type → 415, bad JSON → 400),
    // mapped to `{ error }` by `toErrorResponse`. An empty body is `{}`,
    // which then fails the `name` check below, as it always has.
    const { data: body } = (await readJsonBody(request, {
      allowEmpty: true,
    })) as {
      data: { name?: unknown; scopes?: unknown; expiresInDays?: unknown };
    };

    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!rawName) {
      return NextResponse.json(
        { error: "'name' is required" },
        { status: 400 }
      );
    }
    if (rawName.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 }
      );
    }

    // Scopes default to none if omitted — that yields a key that can
    // only call the scope-free endpoints (e.g. GET /api/v1/me).
    const scopes = normalizeScopes(body?.scopes ?? []);
    if (scopes === null) {
      return NextResponse.json(
        { error: "'scopes' must be an array of known scope strings" },
        { status: 400 }
      );
    }

    // Absent / zero / negative = never expires (the historical default);
    // anything above a year is clamped to it.
    const expiresAt = expiryFromDays(body?.expiresInDays);

    const { plaintext, hash, prefix } = generateApiKey();

    const { data, error } = await ctx.supabase
      .from('api_keys')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        name: rawName,
        key_prefix: prefix,
        key_hash: hash,
        scopes,
        expires_at: expiresAt,
      })
      .select(API_KEY_SAFE_COLUMNS)
      .single();

    if (error || !data) {
      console.error('[POST /api/account/api-keys] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create API key' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        key: data,
        // Plaintext — shown to the admin exactly once.
        plaintext,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
