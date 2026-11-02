import { NextResponse } from 'next/server';
import { resolveEffectiveAccountId } from '@/lib/auth/account';
import { createClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  getSubscribedApps,
  getSubscribedAppsRaw,
  probeGraphField,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import { classifyBizAppStatus } from '@/lib/whatsapp/coexistence';

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side. Solves the failure mode that
 * surfaced the multi-number bug originally: "UI says Connected but
 * Meta isn't delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — local timestamp set by POST /config when
 *                    /register last succeeded; NULL means the
 *                    number was saved but never actually subscribed
 *
 * Plus, always (#1650): Meta's `is_on_biz_app` + `platform_type` of
 * the number. A coexistence number (`true` + `CLOUD_API`) never went
 * through /register, so for it `live` does not require `registered_at`;
 * a number on the WhatsApp Business app WITHOUT coexistence (`true` +
 * anything else) gets `live: false` and `code:
 * 'biz_app_without_coexistence'` — Meta does not deliver its messages.
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // whatsapp_config is one-row-per-account post-017. Resolve the
  // caller's account_id so a teammate who joined an existing account
  // sees the same registration state as the admin who set it up.
  // The effective account (s9.5): the impersonated company inside a
  // support session, never the operator's own profile.
  const accountId =
    (await resolveEffectiveAccountId(supabase, user.id)) ?? undefined;
  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'Your profile is not linked to an account.',
    });
  }

  // Fase 4 §1: probe ONE number. `?config_id=` names it (the Verify
  // button on a card); without it, the account default — which is what
  // the single-number caller meant all along.
  const requestedId = new URL(request.url).searchParams.get('config_id');
  const query = supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId);
  const { data: rows } = await (requestedId
    ? query.eq('id', requestedId)
    : query.eq('is_default', true));
  const config = rows?.[0] ?? null;

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'No WhatsApp configuration saved yet.',
    });
  }

  let accessToken: string;
  try {
    accessToken = decrypt(config.access_token);
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        "Stored access token can't be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.",
    });
  }

  const checks: {
    config_exists: boolean;
    token_decryptable: boolean;
    phone_metadata_ok: boolean;
    waba_subscribed_to_app: boolean | null;
    locally_marked_registered: boolean;
    coexistence_active: boolean;
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registered_at != null,
    coexistence_active: false,
  };
  const errors: string[] = [];

  // 1. Phone metadata
  try {
    await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    });
    checks.phone_metadata_ok = true;
  } catch (err) {
    errors.push(
      `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 1b. Coexistence (#1650): where does the number live? Always probed;
  // a failed probe leaves its field null and falls back to the legacy
  // rule below.
  const [bizProbe, platformProbe] = await Promise.all([
    probeGraphField({
      nodeId: config.phone_number_id,
      field: 'is_on_biz_app',
      accessToken,
    }),
    probeGraphField({
      nodeId: config.phone_number_id,
      field: 'platform_type',
      accessToken,
    }),
  ]);
  const coexistence = {
    is_on_biz_app: bizProbe.ok ? (bizProbe.value ?? null) : null,
    platform_type: platformProbe.ok ? (platformProbe.value ?? null) : null,
  };
  const biz = classifyBizAppStatus(
    coexistence.is_on_biz_app,
    coexistence.platform_type
  );
  checks.coexistence_active = biz === 'coexistence';

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      });
      // Meta returns the apps subscribed to this WABA. If the list
      // is non-empty, OUR app is in there (the access_token we used
      // belongs to our app — Meta wouldn't return data for an app
      // the token can't see). Treat any entry as success.
      checks.waba_subscribed_to_app = subs.length > 0;
      if (!checks.waba_subscribed_to_app) {
        errors.push(
          'WABA has no subscribed apps. Re-save the configuration to subscribe.'
        );
      }
    } catch (err) {
      errors.push(
        `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    errors.push(
      "No WABA ID on file — webhooks can't be wired without it. Add it in the form and re-save."
    );
  }

  // `?detail=1` — what Meta itself says about delivery for this number:
  // its own webhook override (which would divert messages away from the
  // app's URL), its platform, and the raw subscription rows. Read-only.
  let detail: Record<string, unknown> | undefined;
  if (new URL(request.url).searchParams.get('detail') === '1') {
    const fields = [
      'webhook_configuration',
      'platform_type',
      'is_on_biz_app',
      'account_mode',
      'status',
      'code_verification_status',
    ];
    const phone: Record<string, unknown> = {};
    for (const field of fields) {
      const probed = await probeGraphField({
        nodeId: config.phone_number_id,
        field,
        accessToken,
      });
      phone[field] = probed.ok ? probed.value : { error: probed.error };
    }
    detail = {
      phone,
      subscribed_apps: config.waba_id
        ? await getSubscribedAppsRaw({
            wabaId: config.waba_id,
            accessToken,
          })
        : null,
    };
  }

  const delivering =
    checks.phone_metadata_ok && (checks.waba_subscribed_to_app ?? false);
  let live: boolean;
  let code: string | undefined;
  if (biz === 'coexistence') {
    live = delivering;
  } else if (biz === 'biz_app_only') {
    live = false;
    code = 'biz_app_without_coexistence';
  } else {
    live = delivering && checks.locally_marked_registered;
  }

  return NextResponse.json({
    live,
    ...(code ? { code } : {}),
    config_id: config.id,
    checks,
    coexistence,
    errors,
    last_registration_error: config.last_registration_error ?? null,
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
    ...(detail ? { detail } : {}),
  });
}
