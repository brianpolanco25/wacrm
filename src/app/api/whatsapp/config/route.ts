import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { assertStockLimit, assertWritable } from '@/lib/billing/enforce';
import { toErrorResponse } from '@/lib/auth/account';
import { promoteDefault } from '@/lib/whatsapp/default-number';

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data?.account_id) return null;
  return data.account_id as string;
}

// Lazy-initialised service-role client. We need it to detect a
// phone_number_id already claimed by a *different* user — under RLS,
// the user's own session can't see other users' rows, so the conflict
// would be invisible without the service role.
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
 * The shape of a number in the API response. Explicit allow-list, not a
 * spread of the row: `access_token` and `verify_token` are encrypted
 * secrets and must never leave the server, and a `select('*')` that
 * grows a column tomorrow would leak it by default.
 */
function publicNumber(row: Record<string, unknown>) {
  return {
    id: row.id,
    phone_number_id: row.phone_number_id,
    display_phone_number: row.display_phone_number ?? null,
    verified_name: row.verified_name ?? null,
    label: row.label ?? null,
    waba_id: row.waba_id ?? null,
    is_default: row.is_default === true,
    status: row.status,
    registered_at: row.registered_at ?? null,
    subscribed_apps_at: row.subscribed_apps_at ?? null,
    last_registration_error: row.last_registration_error ?? null,
    mirror_inbound_media: row.mirror_inbound_media !== false,
    created_at: row.created_at ?? null,
  };
}

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Post-053 an account can have SEVERAL numbers, so the response grew a
 * `numbers` array. `connected` / `phone_info` still describe ONE number
 * — the default, or the one named by `?config_id=` — because that is
 * what every existing caller (`settings-overview`, the health check in
 * the settings page) reads, and because verifying n numbers against
 * Meta on every page load would be n round trips.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...}, numbers: [...] }
 *   { connected: false, reason: 'no_config',        message: '...', numbers: [] }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true, numbers: [...] }
 *   { connected: false, reason: 'meta_api_error',   message: '...', numbers: [...] }
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 }
      );
    }

    // Default first, then oldest first — the order the settings list
    // renders and the order `numbers[0]` is expected to be the default.
    const { data: rows, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError);
      return NextResponse.json(
        {
          connected: false,
          reason: 'db_error',
          message: 'Failed to fetch configuration',
          numbers: [],
        },
        { status: 200 }
      );
    }

    const numbers = (rows ?? []).map(publicNumber);

    if (!rows || rows.length === 0) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message:
            'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
          numbers,
        },
        { status: 200 }
      );
    }

    // Which one gets verified against Meta. `?config_id=` lets the
    // settings page test a specific card; without it, the default.
    const requestedId = new URL(request.url).searchParams.get('config_id');
    const config = requestedId
      ? rows.find((r: { id: string }) => r.id === requestedId)
      : rows[0];
    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'That WhatsApp number does not exist on this account.',
          numbers,
        },
        { status: 200 }
      );
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token);
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err);
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          numbers,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 }
      );
    }

    // Validate credentials against Meta
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      });
      // Refresh the cached display metadata so the list can render n
      // numbers without n calls to Meta on every page load.
      if (
        phoneInfo?.display_phone_number !== config.display_phone_number ||
        phoneInfo?.verified_name !== config.verified_name
      ) {
        await supabase
          .from('whatsapp_config')
          .update({
            display_phone_number: phoneInfo?.display_phone_number ?? null,
            verified_name: phoneInfo?.verified_name ?? null,
          })
          .eq('id', config.id)
          .eq('account_id', accountId);
      }
      return NextResponse.json({
        connected: true,
        phone_info: phoneInfo,
        config_id: config.id,
        numbers,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      console.error(
        '[whatsapp/config GET] Meta API verification failed:',
        message
      );
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
          numbers,
        },
        { status: 200 }
      );
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error);
    return NextResponse.json(
      {
        connected: false,
        reason: 'unknown',
        message: 'Internal server error',
        numbers: [],
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config for the authenticated user.
 * Verifies credentials with Meta first, then encrypts and stores.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const {
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
      pin,
      // Fase 4 §1: which of the account's numbers this save edits.
      // Absent = add a new one (or overwrite the row that already holds
      // this same `phone_number_id`).
      config_id,
      label,
      is_default,
    } = body;

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      );
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be exactly 6 digits.' },
          { status: 400 }
        );
      }
    }

    // Which row is this save going to overwrite, if any? Three things
    // need the answer: the `numbers` check right below (a save that
    // edits an existing row consumes no allowance), the /register
    // decision further down (whether this number is already
    // registered) and the insert-vs-update branch at the end.
    //
    // Post-053 there can be SEVERAL rows, so this is no longer a
    // `.maybeSingle()` on the account. Two ways to land on one:
    // an explicit `config_id` (the "Edit" button of a card) or, failing
    // that, the row that already holds this `phone_number_id` — which
    // keeps the old behaviour of "re-saving my number is an edit" for
    // callers that never learned about ids.
    const existingQuery = supabase
      .from('whatsapp_config')
      .select('id, registered_at, phone_number_id, is_default')
      .eq('account_id', accountId);
    const { data: existingRows, error: existingErr } = await (config_id
      ? existingQuery.eq('id', config_id)
      : existingQuery.eq('phone_number_id', phone_number_id));
    const existing = existingRows?.[0] ?? null;
    if (!existingErr && config_id && !existing) {
      // An id that isn't ours must read as "not found", never as
      // "create a new row" — otherwise a typo'd id silently adds a
      // number instead of editing one (and CP3: an id from another
      // account must not resolve here at all).
      return NextResponse.json(
        { error: 'That WhatsApp number does not exist on this account.' },
        { status: 404 }
      );
    }
    if (existingErr) {
      // Fail closed: not knowing whether a row exists is not knowing
      // whether this save is an edit or a second number.
      console.error('Error loading existing whatsapp_config:', existingErr);
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      );
    }

    // The cross-account conflict is checked BEFORE the plan gate, and
    // the order is deliberate: a number that belongs to somebody else
    // is not a number you could buy your way into, so answering 402
    // ("upgrade your plan") to it would send the customer to the
    // checkout for a problem money does not solve. Same order as
    // POST /api/whatsapp/embedded-signup (plan §1.3, steps 2 then 3).
    // Reject if another account has already claimed this phone_number_id.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same number causes the webhook's `.single()` lookup to
    // throw PGRST116 ("multiple rows"), silently dropping every
    // inbound message. See issue #136. Post-multi-user we key on
    // account_id (not user_id) since teammates inside the same account
    // all share one config; the conflict is between accounts.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle();

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError);
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      );
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one Cabbity CRM user.',
        },
        { status: 409 }
      );
    }

    // Fase 3 §4 + §5. This route resolves its account by hand instead
    // of through `requireRole`, so the read-only gate that `requireRole`
    // applies everywhere else has to be spelled out here, and the
    // `numbers` limit goes with it.
    //
    // `numbers` is a STOCK limit: how many WhatsApp numbers this
    // account has bound right now. This save adds ONE, so what has to
    // be counted is every OTHER row of the account — excluded by ROW
    // IDENTITY, not by `phone_number_id`. Excluding by number was wrong
    // in the one case that matters: with UNIQUE(account_id) the
    // account's single row holds the OLD number, so changing it (Meta
    // test number -> production number, the normal onboarding path)
    // counted that row and answered 402 on every plan with
    // `numbers: 1`. Saving over the account's own row is an edit and
    // consumes nothing.
    //
    // f4.2 dropped the UNIQUE, so the count is now real: re-saving a
    // number the account already has still costs nothing, and the
    // second DIFFERENT number on a `numbers: 1` plan is a 402.
    const numberCountQuery = supabase
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    const { count: numberCount, error: numberCountErr } = await (existing?.id
      ? numberCountQuery.neq('id', existing.id)
      : numberCountQuery);
    if (numberCountErr) {
      // Fail closed: an uncounted number is not a free number.
      console.error('Error counting configured numbers:', numberCountErr);
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

    // Verify credentials with Meta BEFORE saving
    let phoneInfo;
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      console.error('Meta API verification failed during save:', message);
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 }
      );
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string;
    let encryptedVerifyToken: string | null;
    try {
      encryptedAccessToken = encrypt(access_token);
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown encryption error';
      console.error('Encryption failed:', message);
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      );
    }

    // `existing` was loaded before the billing gate (it is what decides
    // whether this save is an edit). Reused here for the other question
    // it answers: is this number already registered with Meta? If so we
    // can skip /register when the user didn't provide a PIN this time
    // around.
    const sameNumber =
      existing?.phone_number_id === phone_number_id &&
      existing?.registered_at != null;

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existing?.registered_at ?? null;
    let registrationError: string | null = null;
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false;

    const needsRegistration =
      !sameNumber || (typeof pin === 'string' && pin.length > 0);
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). The /register + PIN step only matters for
        // production numbers under a shared WABA (issue #136), so treat
        // it as best-effort: skip it, save the (already Meta-verified)
        // credentials as connected, and leave registered_at null. The
        // UI surfaces a separate "Not registered" banner with a path to
        // add a PIN later for users who do need inbound webhook routing.
        registrationSkipped = true;
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          });
          registeredAt = new Date().toISOString();
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : 'Unknown Meta API error';
          console.error('Phone number /register failed:', registrationError);
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything. The UI
          // surfaces `last_registration_error` so they see WHY it's
          // not actually live yet.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id (legacy rows from before
    // we required it).
    let subscribedAppsAt: string | null = null;
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        });
        subscribedAppsAt = new Date().toISOString();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('WABA subscribed_apps failed (non-fatal):', message);
        // Subscription failures are rare once the App has the right
        // permissions; we don't block save on them — the diagnostic
        // endpoint surfaces this state too.
      }
    }

    // Persist everything in one shot. If /register failed we still
    // store the credentials and the error so the UI can guide the
    // user through a retry.
    const baseRow: Record<string, unknown> = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
      // Cached from the Meta call above so the settings list can render
      // n numbers legibly without n round trips (migration 053).
      display_phone_number: phoneInfo?.display_phone_number ?? null,
      verified_name: phoneInfo?.verified_name ?? null,
    };
    if (typeof label === 'string') baseRow.label = label.trim() || null;

    // First number of the account becomes the default. Later ones do
    // NOT steal it silently — that is what "Make default" is for.
    const wantsDefault =
      is_default === true || (!existing && (numberCount ?? 0) === 0);

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        // Both filters: `id` picks the row, `account_id` is what makes
        // it impossible to edit another tenant's row by guessing a UUID
        // even if RLS were ever bypassed here (CP3).
        .eq('id', existing.id)
        .eq('account_id', accountId);

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError);
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        );
      }
      if (wantsDefault && existing.is_default !== true) {
        const promoted = await promoteDefault(supabase, accountId, existing.id);
        if (!promoted) {
          return NextResponse.json(
            { error: 'Failed to update configuration' },
            { status: 500 }
          );
        }
      }
    } else {
      // Insert with both columns: `account_id` is the tenancy key
      // (NOT NULL post-017), `user_id` is the audit column identifying
      // which member of the account saved the config.
      const { data: insertedRows, error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          ...baseRow,
          // Straight to `is_default` only when the account has no other
          // number: with one, the partial unique index of 053 would
          // reject the insert, and the two-step promotion below is the
          // only order that index accepts.
          is_default: (numberCount ?? 0) === 0,
        })
        .select('id');

      if (insertError || !insertedRows?.[0]) {
        console.error('Error inserting whatsapp_config:', insertError);
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        );
      }
      if (wantsDefault && (numberCount ?? 0) > 0) {
        const promoted = await promoteDefault(
          supabase,
          accountId,
          insertedRows[0].id
        );
        if (!promoted) {
          return NextResponse.json(
            { error: 'Failed to save configuration' },
            { status: 500 }
          );
        }
      }
    }

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      });
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      // Credentials are valid and saved, but inbound webhook
      // registration was skipped because no PIN was supplied (e.g. a
      // Meta test number). The UI shows the "Not registered" banner
      // rather than claiming the number is fully live.
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    });
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/whatsapp/config?id=<uuid>
 *
 * Removes ONE WhatsApp number. Used by the "Reset Configuration" button
 * to recover from a corrupted encrypted token (mismatched
 * ENCRYPTION_KEY across environments) and by "Remove" on a number card.
 *
 * `id` is REQUIRED post-053. The old call shape deleted every row the
 * account had, which with one number was the intent and with three is
 * a catastrophe a misclick away; refusing it is the only safe reading.
 */
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const id = new URL(request.url).searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        {
          error:
            "An 'id' query parameter is required: this endpoint deletes one WhatsApp number, not every number on the account.",
        },
        { status: 400 }
      );
    }

    const { data: deleted, error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, is_default');

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError);
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      );
    }

    if (!deleted || deleted.length === 0) {
      return NextResponse.json(
        { error: 'That WhatsApp number does not exist on this account.' },
        { status: 404 }
      );
    }

    // Deleting the default leaves the account without one, and every
    // send that doesn't name a number would then fall to step 4 of the
    // resolver (oldest survivor). Promote that survivor explicitly so
    // the invariant "an account with numbers has a default" holds.
    if (deleted[0].is_default) {
      const { data: survivors } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (survivors?.[0]) {
        await supabase
          .from('whatsapp_config')
          .update({ is_default: true })
          .eq('id', survivors[0].id)
          .eq('account_id', accountId);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
