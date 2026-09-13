// ============================================================
// The single place that answers "which WhatsApp number does this send
// go out through?" (fase 4 §1, f4.2).
//
// Before migration 053 the answer was trivial: `UNIQUE(account_id)`
// meant one row per account, so every call site did
// `.eq('account_id', …).single()`. Dropping that UNIQUE turns those
// eight `.single()` calls into PGRST116 ("multiple rows") the moment a
// company connects a second number — the send stops working, silently,
// for exactly the customers on the plan that sells multiple numbers.
//
// So every one of them now comes through here. The only deliberate
// exception is the inbound webhook, which resolves by Meta's
// `phone_number_id` (the row IS the tenant resolver there) and is
// guarded by the global UNIQUE of migration 013.
//
// Tenancy: `db` may be the service-role client, which bypasses RLS.
// EVERY query below carries `.eq('account_id', accountId)`, including
// the ones that already filter by a primary key — a `configId` or a
// `conversationId` arriving from a request body is attacker-controlled
// and must never resolve across accounts (CP3).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';

/**
 * The text every caller used to raise from its own `.single()` branch.
 * Kept byte-for-byte: tests and translations key off it.
 */
export const WHATSAPP_NOT_CONFIGURED_MESSAGE =
  'WhatsApp not configured. Please set up your WhatsApp integration first.';

export const WHATSAPP_NUMBER_NOT_FOUND_MESSAGE =
  'The requested WhatsApp number does not exist on this account.';

/**
 * Typed failure with a machine `code` and an HTTP `status`. Deliberately
 * its own class rather than `SendMessageError` or `BroadcastError`:
 * this module is used by the send core, the broadcast core, the flow
 * and automation engines and four routes, and tying it to one of those
 * error families would make the other callers import it transitively.
 * Each caller remaps (`toSendMessageError`, `toBroadcastError`, or a
 * plain `NextResponse`).
 */
export class WhatsAppConfigError extends Error {
  readonly code: 'whatsapp_not_configured' | 'whatsapp_number_not_found';
  readonly status: number;
  constructor(
    code: 'whatsapp_not_configured' | 'whatsapp_number_not_found',
    message: string,
    status: number
  ) {
    super(message);
    this.name = 'WhatsAppConfigError';
    this.code = code;
    this.status = status;
  }
}

export interface WhatsAppConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  phone_number_id: string;
  waba_id?: string | null;
  access_token: string;
  is_default?: boolean;
  label?: string | null;
  display_phone_number?: string | null;
  verified_name?: string | null;
  status?: string;
  mirror_inbound_media?: boolean;
  [key: string]: unknown;
}

export interface ResolvedWhatsAppConfig {
  row: WhatsAppConfigRow;
  /** Present only when `withToken` was requested. */
  accessToken: string;
}

export interface ResolveArgs {
  accountId: string;
  /** Explicit choice by the caller (UI selector, `from` of /api/v1). */
  configId?: string | null;
  /** The number the customer wrote to; beats the account default. */
  conversationId?: string | null;
  /** The call site needs the decrypted access token. */
  withToken?: boolean;
}

const SELECT_ALL = '*';

/**
 * Resolve the WhatsApp number to use, in this fixed order:
 *
 *   1. `configId` — an explicit choice. Never falls through: asking for
 *      a number that isn't yours is an error, not a reason to silently
 *      send through a different one.
 *   2. `conversations.whatsapp_config_id` — the number this thread runs
 *      on. NULL (a thread older than migration 053) falls through.
 *   3. The account default (`is_default`).
 *   4. The oldest surviving row — a safety net for an account whose
 *      default was deleted by hand in SQL.
 *   5. Nothing → `whatsapp_not_configured`.
 */
export async function resolveWhatsAppConfig(
  db: SupabaseClient,
  args: ResolveArgs
): Promise<ResolvedWhatsAppConfig> {
  const { accountId, configId, conversationId, withToken } = args;

  // ---- 1. explicit choice ------------------------------------
  if (configId) {
    const { data } = await db
      .from('whatsapp_config')
      .select(SELECT_ALL)
      .eq('id', configId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!data) {
      throw new WhatsAppConfigError(
        'whatsapp_number_not_found',
        WHATSAPP_NUMBER_NOT_FOUND_MESSAGE,
        404
      );
    }
    return finish(db, data as WhatsAppConfigRow, withToken);
  }

  // ---- 2. the conversation's own number ----------------------
  if (conversationId) {
    const { data: conv } = await db
      .from('conversations')
      .select('whatsapp_config_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    const sealed = conv?.whatsapp_config_id as string | null | undefined;
    if (sealed) {
      const { data } = await db
        .from('whatsapp_config')
        .select(SELECT_ALL)
        .eq('id', sealed)
        .eq('account_id', accountId)
        .maybeSingle();
      // A dangling id means the number was disconnected (the FK is
      // ON DELETE SET NULL, so this is a race rather than a leftover).
      // Fall through to the default instead of failing the send.
      if (data) return finish(db, data as WhatsAppConfigRow, withToken);
    }
  }

  // ---- 3. the account default --------------------------------
  const { data: def } = await db
    .from('whatsapp_config')
    .select(SELECT_ALL)
    .eq('account_id', accountId)
    .eq('is_default', true)
    .maybeSingle();
  if (def) return finish(db, def as WhatsAppConfigRow, withToken);

  // ---- 4. whatever is left -----------------------------------
  const { data: rest } = await db
    .from('whatsapp_config')
    .select(SELECT_ALL)
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1);
  const survivor = Array.isArray(rest) ? rest[0] : null;
  if (survivor) return finish(db, survivor as WhatsAppConfigRow, withToken);

  // ---- 5. nothing --------------------------------------------
  throw new WhatsAppConfigError(
    'whatsapp_not_configured',
    WHATSAPP_NOT_CONFIGURED_MESSAGE,
    400
  );
}

/**
 * List every number of an account, default first then oldest first —
 * the order the settings list and the send selector both render.
 */
export async function listWhatsAppConfigs(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppConfigRow[]> {
  const { data } = await db
    .from('whatsapp_config')
    .select(SELECT_ALL)
    .eq('account_id', accountId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  return (data ?? []) as WhatsAppConfigRow[];
}

/**
 * Translate a customer-facing `phone_number_id` (what an external API
 * client knows) into our internal row id. Returns null when the number
 * isn't one of this account's.
 */
export async function configIdForPhoneNumberId(
  db: SupabaseClient,
  accountId: string,
  phoneNumberId: string
): Promise<string | null> {
  const { data } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * Decrypt the token when the caller asked for it, and keep the
 * fire-and-forget CBC→GCM self-heal that lived in `send-message.ts`.
 * It rewrites by `id` — the row was just read under its account — and
 * only ever runs on an authenticated path.
 */
function finish(
  db: SupabaseClient,
  row: WhatsAppConfigRow,
  withToken?: boolean
): ResolvedWhatsAppConfig {
  if (!withToken) return { row, accessToken: '' };

  const accessToken = decrypt(row.access_token);

  if (isLegacyFormat(row.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', row.id)
      .eq('account_id', row.account_id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[resolve-config] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }

  return { row, accessToken };
}
