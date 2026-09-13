// ============================================================
// Registro integrado (Embedded Signup) — fase 4 §1.
//
// The whole point of the feature in one sentence: a company connects
// WhatsApp without leaving the app and without ever opening the Meta
// console. The browser opens Meta's dialog with OUR app id, the
// customer picks or creates their WhatsApp Business account and their
// number, Meta hands the browser a one-time `code`, and this route
// turns that code into a token scoped to THEIR account, registers the
// number and subscribes their WABA to our app.
//
// Two handlers:
//
//   GET  — "is this deployment in platform mode, and with what ids?"
//          The browser cannot read server env vars and we refuse to
//          bake them into the bundle (see platform-mode.ts), so it
//          asks. `app_id` and `config_id` are public by design: they
//          travel in the dialog URL. `META_APP_SECRET` never appears
//          in the response and is not even part of the object that
//          gets serialised.
//
//   POST — the exchange, in the fixed order documented below. Nothing
//          is written until the token is minted and verified against
//          Meta: a half-written row would show as "connected" in
//          settings and silently send nothing.
//
// In self-hosted mode both handlers behave as if the route did not
// exist (`{enabled:false}` / 404). That is criterion 5 of the spec: the
// self-hosted install keeps working with the customer's own Meta app
// and never sees any of this.
// ============================================================

import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { assertStockLimit, assertWritable } from '@/lib/billing/enforce';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  exchangeCodeForToken,
  generateRegistrationPin,
} from '@/lib/whatsapp/embedded-signup';
import {
  getMetaAppSecret,
  getPlatformSignupConfig,
  isMissingWebhookVerifyToken,
} from '@/lib/whatsapp/platform-mode';
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';

// Service-role client, lazily built. It exists for exactly one query:
// detecting a `phone_number_id` already claimed by a DIFFERENT account.
// Under RLS the caller's own session cannot see other tenants' rows, so
// without the service role the conflict would be invisible and two
// accounts would end up bound to one number — which makes the webhook's
// owner lookup ambiguous and drops every inbound message (issue #136).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

/**
 * GET /api/whatsapp/embedded-signup
 *
 *   200 { enabled: false }
 *   200 { enabled: true, app_id, config_id, graph_version,
 *         warning?: 'missing_verify_token' }
 *
 * Requires an admin session: the ids are public, but the ANSWER
 * ("this deployment is a platform") is operational detail that an
 * anonymous visitor has no business enumerating.
 */
export async function GET() {
  try {
    await requireRole('admin', { allowReadOnly: true });
  } catch (err) {
    return toErrorResponse(err);
  }

  const platform = getPlatformSignupConfig();
  if (!platform) {
    return NextResponse.json({ enabled: false });
  }

  return NextResponse.json({
    enabled: true,
    app_id: platform.appId,
    config_id: platform.configId,
    graph_version: platform.graphVersion,
    // Platform mode writes `verify_token = NULL` on every row, so the
    // per-tenant loop of the webhook GET has nothing left to match:
    // without this variable Meta's webhook verification answers 403
    // forever and no inbound message ever arrives. Surfaced as an
    // operator warning rather than by hiding the button — the signup
    // itself works; it is the webhook that will not.
    ...(isMissingWebhookVerifyToken()
      ? { warning: 'missing_verify_token' as const }
      : {}),
  });
}

interface SignupBody {
  code?: unknown;
  phone_number_id?: unknown;
  waba_id?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * POST /api/whatsapp/embedded-signup
 *
 * Body: `{ code, phone_number_id, waba_id }`, all three required.
 *
 * The order of the steps is load-bearing and is the order of §1.3 of
 * the design note:
 *
 *   0. admin + rate limit
 *   1. platform mode, or 404 (self-hosted never exposes this)
 *   2. cross-account conflict → 409, BEFORE spending the code
 *   3. the `numbers` stock limit, only for a NEW pair → 402
 *   4. code → token. A failure here writes nothing.
 *   5. verifyPhoneNumber with the fresh token → display name / number
 *   6. subscribed_apps — logged, does NOT abort
 *   7. /register with a generated PIN — recorded, does NOT abort
 *   8. encrypt token + PIN
 *   9. one upsert on (account_id, phone_number_id)
 *
 * Steps 2 and 3 are in that order on purpose: a number that belongs to
 * somebody else is not a number you can buy your way into, so answering
 * 402 ("upgrade your plan") would send the customer to a checkout for a
 * problem money does not solve.
 */
export async function POST(request: Request) {
  // ---- 0. who is asking ---------------------------------------
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }
  const { supabase, accountId, userId } = ctx;

  const limit = checkRateLimit(
    `embedded-signup:${userId}`,
    RATE_LIMITS.embeddedSignup
  );
  if (!limit.success) return rateLimitResponse(limit);

  // ---- 1. platform mode ---------------------------------------
  const platform = getPlatformSignupConfig();
  const appSecret = getMetaAppSecret();
  if (!platform || !appSecret) {
    // 404, not 403: in self-hosted mode this endpoint does not exist as
    // a concept, and saying "forbidden" would suggest the right session
    // could reach it.
    return NextResponse.json(
      { error: 'embedded_signup_disabled' },
      { status: 404 }
    );
  }

  let body: SignupBody;
  try {
    body = (await request.json()) as SignupBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const code = asString(body.code);
  const phoneNumberId = asString(body.phone_number_id);
  const wabaId = asString(body.waba_id);

  if (!code || !phoneNumberId || !wabaId) {
    // The dialog can finish without one of the three: the session event
    // carries the ids and the login callback carries the code, and a
    // window closed at the wrong instant delivers one but not the
    // other. Writing a row from a partial result would produce a
    // configuration that reads as connected and sends nothing, so the
    // answer is an actionable 400 and zero writes.
    return NextResponse.json(
      {
        error:
          'The signup did not complete: close the dialog and press Connect WhatsApp again.',
        code: 'incomplete_signup',
      },
      { status: 400 }
    );
  }

  try {
    // ---- 2. is this number already somebody else's? -----------
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .neq('account_id', accountId)
      .maybeSingle();

    if (claimedError) {
      console.error(
        '[embedded-signup] ownership check failed:',
        claimedError.message
      );
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      );
    }
    if (claimed) {
      // Byte-for-byte the message of POST /api/whatsapp/config: same
      // situation, same remedy, and the UI already translates it.
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 }
      );
    }

    // Which of the account's own rows, if any, this signup overwrites.
    // Read through the caller's RLS-scoped client AND filtered by
    // account: the number came from the request and must never resolve
    // across tenants (CP3).
    const { data: existingRows, error: existingErr } = await supabase
      .from('whatsapp_config')
      .select('id, is_default')
      .eq('account_id', accountId)
      .eq('phone_number_id', phoneNumberId);
    if (existingErr) {
      // Fail closed: not knowing whether the row exists is not knowing
      // whether this is a reconnection or a second number.
      console.error(
        '[embedded-signup] existing row lookup failed:',
        existingErr.message
      );
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      );
    }
    const existing = existingRows?.[0] ?? null;

    // ---- 3. the `numbers` stock limit -------------------------
    // Only for a genuinely NEW pair. Reconnecting a number the account
    // already has — the recovery path when a token goes bad — consumes
    // no allowance, which is the semantics f3.4 settled on and f4.2
    // kept.
    const numberCountQuery = supabase
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    const { count: numberCount, error: countErr } = await (existing?.id
      ? numberCountQuery.neq('id', existing.id)
      : numberCountQuery);
    if (countErr) {
      console.error(
        '[embedded-signup] counting numbers failed:',
        countErr.message
      );
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      );
    }
    try {
      const entitlements = await assertWritable(accountId);
      assertStockLimit(entitlements, 'numbers', numberCount ?? 0);
    } catch (err) {
      return toErrorResponse(err);
    }

    // ---- 4. code → token --------------------------------------
    // Everything from here on spends something irreversible: the code
    // is single-use. Nothing has been written yet, and nothing will be
    // until step 9.
    let exchanged;
    try {
      exchanged = await exchangeCodeForToken({
        code,
        appId: platform.appId,
        appSecret,
        graphVersion: platform.graphVersion,
      });
    } catch (err) {
      // `err.message` only. The thrown object never carries the code or
      // the token (see embedded-signup.ts) and this is the line that
      // keeps it that way: logging `err` whole would eventually print a
      // request object with the credentials in it.
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[embedded-signup] code exchange failed:', message);
      return NextResponse.json(
        { error: `Meta rejected the sign-up: ${message}` },
        { status: 400 }
      );
    }
    const accessToken = exchanged.accessToken;

    // ---- 5. does the token actually open this number? ---------
    let phoneInfo;
    try {
      phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[embedded-signup] phone verification failed:', message);
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 }
      );
    }

    // ---- 6. subscribe the WABA to OUR app ---------------------
    // This is what makes the customer's inbound traffic arrive at our
    // webhook and, with it, what makes one `META_APP_SECRET` verify
    // every tenant's signature: Meta signs with the secret of the app
    // that owns the subscription, and from here on that app is ours for
    // everybody. Non-fatal on failure, same criterion as the manual
    // path: the row is worth saving and the diagnostic surfaces it.
    let subscribedAppsAt: string | null = null;
    try {
      await subscribeWabaToApp({ wabaId, accessToken });
      subscribedAppsAt = new Date().toISOString();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.warn('[embedded-signup] subscribed_apps failed:', message);
    }

    // ---- 7. register the number with a PIN we generate ---------
    // Numbers created by the dialog have no two-step verification, so
    // we pick the PIN and keep it (encrypted) — without it a future
    // re-registration would have to go through Meta support. If the
    // business already had 2FA with their own PIN, Meta rejects this
    // with a clear message: it is recorded and the manual PIN field in
    // settings is the retry path. Never retried automatically.
    const pin = generateRegistrationPin();
    let registeredAt: string | null = null;
    let registrationError: string | null = null;
    try {
      await registerPhoneNumber({ phoneNumberId, accessToken, pin });
      registeredAt = new Date().toISOString();
    } catch (err) {
      registrationError = err instanceof Error ? err.message : 'Unknown error';
      console.error('[embedded-signup] /register failed:', registrationError);
    }

    // ---- 8. encrypt the two secrets ---------------------------
    let encryptedToken: string;
    let encryptedPin: string;
    try {
      encryptedToken = encrypt(accessToken);
      encryptedPin = encrypt(pin);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[embedded-signup] encryption failed:', message);
      return NextResponse.json(
        {
          error:
            'Failed to encrypt the access token. Check that ENCRYPTION_KEY is a valid 64-character hex string in this environment.',
        },
        { status: 500 }
      );
    }

    // ---- 9. one upsert ----------------------------------------
    const row: Record<string, unknown> = {
      account_id: accountId,
      user_id: userId,
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: encryptedToken,
      // Always NULL in platform mode: the webhook is configured once at
      // app level with META_WEBHOOK_VERIFY_TOKEN, so a per-tenant verify
      // token has nothing to verify. §5 of the design note.
      verify_token: null,
      registration_pin: encryptedPin,
      token_expires_at: exchanged.expiresAt,
      provisioned_via: 'embedded_signup',
      display_phone_number: phoneInfo?.display_phone_number ?? null,
      verified_name: phoneInfo?.verified_name ?? null,
      status: 'connected',
      connected_at: new Date().toISOString(),
      registered_at: registeredAt,
      subscribed_apps_at: subscribedAppsAt,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    };
    // `is_default` is written only when the row is NEW and the account
    // has nothing else: on a repeat pass the column is omitted so the
    // upsert cannot demote (or steal) the account's current default,
    // and the partial unique index of 053 cannot be violated.
    if (!existing && (numberCount ?? 0) === 0) row.is_default = true;

    const { data: saved, error: upsertError } = await supabase
      .from('whatsapp_config')
      .upsert(row, { onConflict: 'account_id,phone_number_id' })
      .select('id');

    if (upsertError || !saved?.[0]) {
      console.error(
        '[embedded-signup] saving the configuration failed:',
        upsertError?.message ?? 'no row returned'
      );
      return NextResponse.json(
        { error: 'Failed to save configuration' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: registrationError == null,
      config_id: saved[0].id,
      registered: registeredAt != null,
      subscribed: subscribedAppsAt != null,
      registration_error: registrationError,
      phone_info: phoneInfo,
    });
  } catch (error) {
    // Deliberately not `console.error(error)` with the object: the
    // catch-all covers the steps that hold the code and the token.
    console.error(
      '[embedded-signup] unexpected failure:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
