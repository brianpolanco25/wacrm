// ============================================================
// #1651 — Webhook de coexistencia: ecos del teléfono, historial,
// libreta de contactos y baja del socio.
//
// A number in coexistence (#1650) stays on the phone's WhatsApp
// Business app AND on Cloud API. Meta then sends three extra webhook
// fields for it, plus the account-level `PARTNER_REMOVED`:
//
//   smb_message_echoes  what the business sent FROM THE PHONE (including
//                       deletions `revoke` and corrections `edit`). Saved
//                       inline as outgoing messages.
//   history             the chat history, by phases and out-of-order
//                       chunks, thousands of messages per delivery.
//                       Captured as a batch (`whatsapp_coexistence_batches`)
//                       and drained by `coexistence-batches.ts`.
//   smb_app_state_sync  the phone's address book. Captured as a batch too.
//   account_update      `PARTNER_REMOVED`: the business disconnected the
//                       platform from the phone; the number's rows go
//                       `disconnected` and the #1650 sync columns reset.
//
// Hard rules, all deliberate:
//   - The account is ONLY the one of the `whatsapp_config` row the
//     `phone_number_id` resolves to (or, for batches, the one copied to
//     the batch when it was queued). Every service-role query carries it.
//   - None of this fires automations, flows, AI replies, public webhooks
//     or charges, and none of it goes through billing enforcement: this
//     is the business's own past and present activity, not new inbound.
//   - Logs carry ids, field names, codes and counts only — never a
//     message body, caption, contact name or phone number.
//   - Nothing here throws to the webhook: Meta already has its 200.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  findOrCreateContact,
  findOrCreateConversation,
} from '@/lib/whatsapp/inbound-thread';
import { wabaConfigsSignedBy } from '@/lib/whatsapp/tenant-app-secret';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveInboundMediaUrl } from '@/lib/whatsapp/inbound-media-url';

export const COEXISTENCE_FIELDS = [
  'smb_message_echoes',
  'history',
  'smb_app_state_sync',
] as const;
export type CoexistenceField = (typeof COEXISTENCE_FIELDS)[number];

export function isCoexistenceField(field: unknown): field is CoexistenceField {
  return (
    typeof field === 'string' &&
    (COEXISTENCE_FIELDS as readonly string[]).includes(field)
  );
}

/** The customer declined to share the chat history (Meta error code). */
export const HISTORY_DECLINED_ERROR_CODE = 2593109;
/** Fewer digits than this is not a phone number we can file a chat under. */
export const MIN_PHONE_DIGITS = 7;
export const DELETED_MARKER = '[deleted]';
export const MEDIA_PLACEHOLDER_MARKER = '[media]';
/** Rows per `messages` upsert. */
export const MESSAGE_UPSERT_CHUNK = 500;

/** The `whatsapp_config` row `resolveInboundConfig` returned. */
export interface CoexistenceConfig {
  id: string;
  account_id: string;
  user_id: string;
  phone_number_id: string;
  display_phone_number?: string | null;
  /**
   * `whatsapp_config.coexistence_onboarded_at` (088): the start of the
   * current coexistence connection. Copied onto each batch as its
   * `sync_epoch`, so a reconnect after PARTNER_REMOVED is a new history
   * sync whose chunks never collide with the old ones (review finding 6).
   */
  coexistence_onboarded_at?: string | null;
  /**
   * The row's ENCRYPTED `access_token` (the webhook hands over the whole
   * `whatsapp_config` row). Decrypted in memory only to verify the media
   * of an echo with Meta (m14.2) — never persisted, never logged.
   */
  access_token?: string | null;
  /** `whatsapp_config.mirror_inbound_media` (039). Unset counts as ON. */
  mirror_inbound_media?: boolean | null;
}

export type CoexistenceMessageStatus =
  'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface CoexistenceMessage {
  wamid: string;
  /** ISO timestamp of Meta's `timestamp` (seconds). */
  createdAt: string;
  senderType: 'customer' | 'agent';
  status: CoexistenceMessageStatus;
  /**
   * The text form: the body, or the `[<type>] caption` marker for media.
   * It is the row's `content_text` unless `media` resolved, and always
   * the conversation's `last_message_text`.
   */
  contentText: string;
  /**
   * Echo media Meta can still serve by id (m14.2). Set by the parser;
   * resolved into `stored` by the echo handler.
   */
  media?: EchoMedia;
  /**
   * The row as an inbound attachment: set only once the media resolved
   * to a URL. Absent → a text row with `contentText` and no media.
   */
  stored?: StoredMedia;
}

/** Media kinds an echo can carry by id, as Meta names them. */
export const ECHO_MEDIA_TYPES = [
  'image',
  'video',
  'audio',
  'document',
  'sticker',
] as const;
export type EchoMediaType = (typeof ECHO_MEDIA_TYPES)[number];

export interface EchoMedia {
  type: EchoMediaType;
  id: string;
  mimeType: string | null;
  caption: string | null;
  fileName: string | null;
  /** Meta's `timestamp` (epoch seconds), for the mirrored file name. */
  timestamp: string | null;
}

export interface StoredMedia {
  contentType: 'image' | 'video' | 'audio' | 'document';
  contentText: string | null;
  mediaUrl: string;
  mediaType: string | null;
}

/**
 * `messages.content_type` for an echo's media, mapped as the inbound
 * webhook maps it (`ALLOWED_CONTENT_TYPES`): a sticker is an image.
 */
export function contentTypeForMedia(
  type: EchoMediaType
): StoredMedia['contentType'] {
  return type === 'sticker' ? 'image' : type;
}

/**
 * The row of a resolved echo media, equivalent to the inbound one:
 * `content_text` is the caption (a document falls back to its file
 * name, which the inbox shows as the attachment's name) or null.
 */
export function storedMediaFor(
  media: EchoMedia,
  mediaUrl: string
): StoredMedia {
  return {
    contentType: contentTypeForMedia(media.type),
    contentText:
      media.caption ?? (media.type === 'document' ? media.fileName : null),
    mediaUrl,
    mediaType: media.mimeType,
  };
}

// ------------------------------------------------------------------
// Pure parsers — tolerate missing fields and unexpected types, never throw
// ------------------------------------------------------------------

type Obj = Record<string, unknown>;

function asObject(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asInt(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Digits of a phone number, or '' when it has fewer than MIN_PHONE_DIGITS. */
function usablePhone(value: unknown): string {
  const digits = normalizePhone(typeof value === 'string' ? value : '');
  return digits.length >= MIN_PHONE_DIGITS ? digits : '';
}

function timestampToIso(value: unknown): string {
  const seconds = asInt(value);
  if (seconds !== null && seconds > 0) {
    const date = new Date(seconds * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

/**
 * What a coexistence message shows in the thread: the text body, or a
 * `[<type>]` marker (plus the caption) for media — nothing is downloaded
 * from Meta — or `[media]` for a history `media_placeholder`.
 */
export function contentTextFor(message: Record<string, unknown>): string {
  const msg = asObject(message) ?? {};
  const type = asString(msg.type) ?? 'unknown';
  if (type === 'media_placeholder') return MEDIA_PLACEHOLDER_MARKER;
  const inner = asObject(msg[type]);
  if (type === 'text') {
    return asString(inner?.body) ?? '[text]';
  }
  const caption = asString(inner?.caption);
  return caption ? `[${type}] ${caption}` : `[${type}]`;
}

const HISTORY_STATUS: Record<string, CoexistenceMessageStatus> = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  PENDING: 'sending',
  ERROR: 'failed',
};

export function mapHistoryStatus(
  raw: unknown,
  senderType: 'customer' | 'agent'
): CoexistenceMessageStatus {
  const key = typeof raw === 'string' ? raw.toUpperCase() : '';
  return HISTORY_STATUS[key] ?? (senderType === 'agent' ? 'sent' : 'delivered');
}

export type ParsedEcho =
  | { kind: 'message'; phone: string; message: CoexistenceMessage }
  | { kind: 'revoke'; phone: string; wamid: string; originalId: string }
  | {
      kind: 'edit';
      phone: string;
      wamid: string;
      originalId: string;
      contentText: string;
      /**
       * The new caption when the edited message is media (null without
       * one). Written as-is when the original row is an attachment, so
       * its caption never gets the `[<type>]` prefix (m14.2).
       */
      caption?: string | null;
    };

/**
 * The media of an echo that Meta delivered by id, or null (text, any
 * other type, or a media object without `id`).
 */
export function echoMediaFor(echo: Record<string, unknown>): EchoMedia | null {
  const msg = asObject(echo) ?? {};
  const type = asString(msg.type);
  if (!type || !(ECHO_MEDIA_TYPES as readonly string[]).includes(type)) {
    return null;
  }
  const inner = asObject(msg[type]);
  const id = asString(inner?.id);
  if (!id) return null;
  const timestamp = msg.timestamp;
  return {
    type: type as EchoMediaType,
    id,
    mimeType: asString(inner?.mime_type),
    caption: asString(inner?.caption),
    fileName: asString(inner?.filename),
    timestamp:
      typeof timestamp === 'string' || typeof timestamp === 'number'
        ? String(timestamp)
        : null,
  };
}

/** `value.message_echoes[]` → echoes; `skipped` lists the wamids dropped. */
export function parseMessageEchoes(value: unknown): {
  echoes: ParsedEcho[];
  skipped: string[];
} {
  const echoes: ParsedEcho[] = [];
  const skipped: string[] = [];
  for (const raw of asArray(asObject(value)?.message_echoes)) {
    const echo = asObject(raw);
    if (!echo) continue;
    const wamid = asString(echo.id);
    if (!wamid) continue;
    const phone = usablePhone(echo.to);
    if (!phone) {
      skipped.push(wamid);
      continue;
    }
    const type = asString(echo.type) ?? 'unknown';
    if (type === 'revoke' || type === 'edit') {
      const inner = asObject(echo[type]);
      const originalId = asString(inner?.original_message_id);
      if (!originalId) {
        skipped.push(wamid);
        continue;
      }
      if (type === 'revoke') {
        echoes.push({ kind: 'revoke', phone, wamid, originalId });
      } else {
        const edited = asObject(inner?.message) ?? {};
        const editedType = asString(edited.type);
        echoes.push({
          kind: 'edit',
          phone,
          wamid,
          originalId,
          contentText: contentTextFor(edited),
          ...(editedType && editedType !== 'text'
            ? { caption: asString(asObject(edited[editedType])?.caption) }
            : {}),
        });
      }
      continue;
    }
    const media = echoMediaFor(echo);
    echoes.push({
      kind: 'message',
      phone,
      message: {
        wamid,
        createdAt: timestampToIso(echo.timestamp),
        senderType: 'agent',
        status: 'sent',
        contentText: contentTextFor(echo),
        ...(media ? { media } : {}),
      },
    });
  }
  return { echoes, skipped };
}

export interface HistoryItem {
  phase: number | null;
  chunkOrder: number | null;
  progress: number | null;
  threads: unknown[];
}

/**
 * `value.history[]` → the chunks to capture, and the error codes of the
 * elements that carried `errors[]` (those capture nothing).
 */
export function parseHistoryItems(value: unknown): {
  items: HistoryItem[];
  errorCodes: number[];
} {
  const items: HistoryItem[] = [];
  const errorCodes: number[] = [];
  for (const raw of asArray(asObject(value)?.history)) {
    const item = asObject(raw);
    if (!item) continue;
    const errors = asArray(item.errors);
    if (errors.length > 0) {
      for (const e of errors) {
        errorCodes.push(asInt(asObject(e)?.code) ?? -1);
      }
      continue;
    }
    const meta = asObject(item.metadata);
    items.push({
      phase: asInt(meta?.phase),
      chunkOrder: asInt(meta?.chunk_order),
      progress: asInt(meta?.progress),
      threads: asArray(item.threads),
    });
  }
  return { items, errorCodes };
}

/**
 * One raw history thread → the counterpart's phone and its messages in
 * ascending time order. A message is the business's (`agent`) when it
 * carries `to` (only echoes do) or its `from` is the business number.
 * null when the thread has no usable phone.
 */
export function parseHistoryThread(
  thread: unknown,
  businessPhone: string
): { phone: string; messages: CoexistenceMessage[] } | null {
  const t = asObject(thread);
  if (!t) return null;
  const phone = usablePhone(t.id);
  if (!phone) return null;
  const business = normalizePhone(businessPhone ?? '');
  const messages: CoexistenceMessage[] = [];
  for (const raw of asArray(t.messages)) {
    const m = asObject(raw);
    if (!m) continue;
    const wamid = asString(m.id);
    if (!wamid) continue;
    const from = normalizePhone(typeof m.from === 'string' ? m.from : '');
    const senderType: 'customer' | 'agent' =
      asString(m.to) || (business && from === business) ? 'agent' : 'customer';
    messages.push({
      wamid,
      createdAt: timestampToIso(m.timestamp),
      senderType,
      status: mapHistoryStatus(asObject(m.history_context)?.status, senderType),
      contentText: contentTextFor(m),
    });
  }
  // Stable sort: equal timestamps keep Meta's order.
  messages.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  );
  return { phone, messages };
}

export interface StateSyncContact {
  action: 'add' | 'remove';
  phone: string;
  name: string | null;
}

/** One `state_sync[]` element → a contact change, or why it was skipped. */
export function parseStateSyncItem(
  item: unknown
): StateSyncContact | 'invalid' | 'ignored' {
  const it = asObject(item);
  if (!it) return 'invalid';
  if (it.type !== 'contact') return 'ignored';
  const contact = asObject(it.contact);
  const phone = usablePhone(contact?.phone_number);
  if (!phone) return 'invalid';
  if (it.action === 'remove') return { action: 'remove', phone, name: null };
  if (it.action !== 'add') return 'ignored';
  const name =
    asString(
      typeof contact?.full_name === 'string' ? contact.full_name.trim() : null
    ) ??
    asString(
      typeof contact?.first_name === 'string' ? contact.first_name.trim() : null
    );
  return { action: 'add', phone, name };
}

// ------------------------------------------------------------------
// Writing a thread (echoes and history)
// ------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Insert a thread's messages into the conversation of `phone` in the
 * config's account (creating the contact and conversation with the same
 * dedupe rules as an inbound). Idempotent on (conversation_id,
 * message_id) — the unique index of migration 037. Moves the
 * conversation's `last_message_*` only forward, never touches
 * `unread_count` or `status`. null when the contact, conversation or an
 * insert failed.
 */
export async function storeThreadMessages(
  db: SupabaseClient,
  config: CoexistenceConfig,
  phone: string,
  messages: CoexistenceMessage[]
): Promise<{ inserted: number } | null> {
  if (messages.length === 0) return { inserted: 0 };

  const contact = await findOrCreateContact(
    db,
    config.account_id,
    config.user_id,
    { phone, waUserId: null, username: null, name: null }
  );
  if (!contact) return null;
  const conv = await findOrCreateConversation(
    db,
    config.account_id,
    config.user_id,
    contact.contact.id,
    config.id
  );
  if (!conv) return null;
  const conversationId = conv.conversation.id as string;

  // One row per wamid, oldest first.
  const seen = new Set<string>();
  const ordered = [...messages]
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    )
    .filter((m) => (seen.has(m.wamid) ? false : (seen.add(m.wamid), true)));

  // The summary is always the text form (marker + caption for media),
  // even when the row itself carries the attachment and its caption.
  const summaryOf = new Map(ordered.map((m) => [m.wamid, m.contentText]));

  let inserted = 0;
  let latest: { created_at: string; content_text: string } | null = null;
  let failed = false;
  for (let i = 0; i < ordered.length; i += MESSAGE_UPSERT_CHUNK) {
    const rows = ordered.slice(i, i + MESSAGE_UPSERT_CHUNK).map((m) => ({
      conversation_id: conversationId,
      sender_type: m.senderType,
      sender_id: null,
      content_type: m.stored?.contentType ?? 'text',
      content_text: m.stored ? m.stored.contentText : m.contentText,
      media_url: m.stored?.mediaUrl ?? null,
      media_type: m.stored?.mediaType ?? null,
      message_id: m.wamid,
      status: m.status,
      created_at: m.createdAt,
    }));
    const { data, error } = await db
      .from('messages')
      .upsert(rows, {
        onConflict: 'conversation_id,message_id',
        ignoreDuplicates: true,
      })
      .select('id, created_at, message_id');
    if (error) {
      console.error(
        '[webhook] coexistence messages insert failed:',
        JSON.stringify({
          conversationId,
          code: (error as { code?: string }).code ?? null,
          error: errorMessage(error),
        })
      );
      failed = true;
      break;
    }
    for (const row of (data ?? []) as {
      created_at: string;
      message_id: string;
    }[]) {
      inserted += 1;
      if (!latest || row.created_at > latest.created_at) {
        latest = {
          created_at: row.created_at,
          content_text: summaryOf.get(row.message_id) ?? '',
        };
      }
    }
  }

  if (latest) {
    const { error } = await db
      .from('conversations')
      .update({
        last_message_text: latest.content_text,
        last_message_at: latest.created_at,
      })
      .eq('id', conversationId)
      .eq('account_id', config.account_id)
      .or(`last_message_at.is.null,last_message_at.lt.${latest.created_at}`);
    if (error) {
      console.error(
        '[webhook] coexistence conversation summary update failed:',
        JSON.stringify({ conversationId, error: errorMessage(error) })
      );
    }
  }

  return failed ? null : { inserted };
}

/**
 * `revoke` / `edit` of a message the business deleted or corrected on
 * the phone: rewrite the original row's `content_text`. Lookup only —
 * never creates a contact or a conversation. true when a row changed.
 *
 * Since m14.2 an echo can be an attachment row. A revoke turns it back
 * into a text row (no media left to show); an edit of an attachment
 * writes the bare caption, while a text row keeps the marker.
 */
async function applyEchoRewrite(
  db: SupabaseClient,
  config: CoexistenceConfig,
  echo: Extract<ParsedEcho, { kind: 'revoke' | 'edit' }>
): Promise<boolean> {
  let updated = false;
  const contact = await findExistingContact(db, config.account_id, echo.phone);
  if (contact) {
    const { data: convRows } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', config.account_id)
      .eq('contact_id', contact.id)
      .order('created_at', { ascending: true })
      .limit(1);
    const conversationId = (convRows as { id: string }[] | null)?.[0]?.id;
    if (conversationId) {
      let patch: Record<string, unknown> =
        echo.kind === 'revoke'
          ? {
              content_text: DELETED_MARKER,
              content_type: 'text',
              media_url: null,
              media_type: null,
            }
          : { content_text: echo.contentText };
      if (echo.kind === 'edit' && echo.caption !== undefined) {
        const { data: target } = await db
          .from('messages')
          .select('id, content_type')
          .eq('conversation_id', conversationId)
          .eq('message_id', echo.originalId)
          .limit(1);
        const targetType = (target as { content_type: string }[] | null)?.[0]
          ?.content_type;
        if (targetType && targetType !== 'text') {
          patch = { content_text: echo.caption };
        }
      }
      const { data, error } = await db
        .from('messages')
        .update(patch)
        .eq('conversation_id', conversationId)
        .eq('message_id', echo.originalId)
        .select('id');
      if (error) {
        console.error(
          '[webhook] echo rewrite failed:',
          JSON.stringify({
            wamid: echo.wamid,
            originalId: echo.originalId,
            error: errorMessage(error),
          })
        );
      }
      updated = !error && Array.isArray(data) && data.length > 0;
    }
  }
  if (!updated) {
    console.warn(
      '[webhook] echo target not found:',
      JSON.stringify({
        wamid: echo.wamid,
        originalId: echo.originalId,
        type: echo.kind,
      })
    );
  }
  return updated;
}

/** The decrypted token for echo media, or null (logged, never thrown). */
function echoMediaToken(config: CoexistenceConfig): string | null {
  if (!config.access_token) {
    console.warn(
      '[webhook] echo media without access token; kept as marker:',
      JSON.stringify({ phoneNumberId: config.phone_number_id })
    );
    return null;
  }
  try {
    return decrypt(config.access_token);
  } catch (err) {
    console.error(
      '[webhook] echo media token could not be decrypted:',
      JSON.stringify({
        phoneNumberId: config.phone_number_id,
        error: errorMessage(err),
      })
    );
    return null;
  }
}

/**
 * An echo's media → the row of an inbound attachment (m14.2), with the
 * same verify / mirror / proxy path as the inbound webhook. null when
 * there is no token or Meta could not verify the id: the echo then
 * stays the `[<type>] caption` marker. Best effort, never throws.
 */
async function resolveEchoMedia(
  db: SupabaseClient,
  config: CoexistenceConfig,
  message: CoexistenceMessage,
  accessToken: string | null
): Promise<StoredMedia | null> {
  const media = message.media;
  if (!media || !accessToken) return null;
  // Never throws: resolveInboundMediaUrl logs and returns null itself.
  const mediaUrl = await resolveInboundMediaUrl({
    mediaId: media.id,
    accessToken,
    mirror:
      config.mirror_inbound_media !== false
        ? { storage: db.storage, accountId: config.account_id }
        : null,
    fileName: media.type === 'document' ? media.fileName : null,
    messageTimestamp: media.timestamp,
  });
  return mediaUrl ? storedMediaFor(media, mediaUrl) : null;
}

async function handleEchoes(
  db: SupabaseClient,
  value: unknown,
  config: CoexistenceConfig
): Promise<void> {
  const { echoes, skipped } = parseMessageEchoes(value);
  for (const wamid of skipped) {
    console.warn('[webhook] echo without recipient; skipped:', wamid);
  }
  let inserted = 0;
  let rewritten = 0;
  let failed = 0;
  let mediaToken: string | null | undefined;
  for (const echo of echoes) {
    if (echo.kind === 'message') {
      let message = echo.message;
      if (message.media) {
        if (mediaToken === undefined) mediaToken = echoMediaToken(config);
        const stored = await resolveEchoMedia(db, config, message, mediaToken);
        if (stored) message = { ...message, stored };
      }
      const result = await storeThreadMessages(db, config, echo.phone, [
        message,
      ]);
      if (result) inserted += result.inserted;
      else failed += 1;
    } else if (await applyEchoRewrite(db, config, echo)) {
      rewritten += 1;
    }
  }
  console.log(
    '[webhook] message echoes:',
    JSON.stringify({
      phoneNumberId: config.phone_number_id,
      received: echoes.length + skipped.length,
      inserted,
      rewritten,
      skipped: skipped.length,
      failed,
    })
  );
}

// ------------------------------------------------------------------
// Capture of history chunks and address-book deliveries (batches)
// ------------------------------------------------------------------

async function queueHistoryItem(
  db: SupabaseClient,
  config: CoexistenceConfig,
  item: HistoryItem
): Promise<string | null> {
  const logRepeat = (batchId: string | null) =>
    console.log(
      '[webhook] history chunk already queued:',
      JSON.stringify({
        phoneNumberId: config.phone_number_id,
        batchId,
        phase: item.phase,
        chunkOrder: item.chunkOrder,
      })
    );
  const syncEpoch = config.coexistence_onboarded_at ?? null;

  let existing = db
    .from('whatsapp_coexistence_batches')
    .select('id')
    .eq('account_id', config.account_id)
    .eq('whatsapp_config_id', config.id)
    .eq('field', 'history');
  existing =
    syncEpoch === null
      ? existing.is('sync_epoch', null)
      : existing.eq('sync_epoch', syncEpoch);
  existing =
    item.phase === null
      ? existing.is('phase', null)
      : existing.eq('phase', item.phase);
  existing =
    item.chunkOrder === null
      ? existing.is('chunk_order', null)
      : existing.eq('chunk_order', item.chunkOrder);
  const { data: found } = await existing.limit(1);
  const foundId = (found as { id: string }[] | null)?.[0]?.id;
  if (foundId) {
    logRepeat(foundId);
    return null;
  }

  const { data, error } = await db
    .from('whatsapp_coexistence_batches')
    .insert({
      account_id: config.account_id,
      whatsapp_config_id: config.id,
      field: 'history',
      sync_epoch: syncEpoch,
      phase: item.phase,
      chunk_order: item.chunkOrder,
      progress: item.progress,
      payload: {
        display_phone_number: config.display_phone_number ?? null,
        threads: item.threads,
      },
      item_count: item.threads.length,
      cursor: 0,
      status: 'pending',
      attempts: 0,
    })
    .select('id')
    .single();
  if (error) {
    // Two deliveries of the same chunk racing: the unique index of 089
    // keeps one; the loser is a repeat, not a failure.
    if (isUniqueViolation(error)) {
      logRepeat(null);
      return null;
    }
    console.error(
      '[webhook] history chunk could not be queued:',
      JSON.stringify({
        phoneNumberId: config.phone_number_id,
        phase: item.phase,
        chunkOrder: item.chunkOrder,
        error: errorMessage(error),
      })
    );
    return null;
  }
  const id = (data as { id: string }).id;
  console.log(
    '[webhook] history chunk queued:',
    JSON.stringify({
      phoneNumberId: config.phone_number_id,
      batchId: id,
      phase: item.phase,
      chunkOrder: item.chunkOrder,
      progress: item.progress,
      threads: item.threads.length,
    })
  );
  return id;
}

async function queueStateSync(
  db: SupabaseClient,
  config: CoexistenceConfig,
  value: unknown
): Promise<string | null> {
  const items = asArray(asObject(value)?.state_sync);
  if (items.length === 0) {
    console.log(
      '[webhook] contacts sync empty:',
      JSON.stringify({ phoneNumberId: config.phone_number_id })
    );
    return null;
  }
  const { data, error } = await db
    .from('whatsapp_coexistence_batches')
    .insert({
      account_id: config.account_id,
      whatsapp_config_id: config.id,
      field: 'smb_app_state_sync',
      sync_epoch: config.coexistence_onboarded_at ?? null,
      payload: { state_sync: items },
      item_count: items.length,
      cursor: 0,
      status: 'pending',
      attempts: 0,
    })
    .select('id')
    .single();
  if (error) {
    console.error(
      '[webhook] contacts sync could not be queued:',
      JSON.stringify({
        phoneNumberId: config.phone_number_id,
        error: errorMessage(error),
      })
    );
    return null;
  }
  const id = (data as { id: string }).id;
  console.log(
    '[webhook] contacts sync queued:',
    JSON.stringify({
      phoneNumberId: config.phone_number_id,
      batchId: id,
      items: items.length,
    })
  );
  return id;
}

/**
 * One `change` of a coexistence field on a resolved number. Echoes are
 * written inline; `history` and `smb_app_state_sync` are captured as
 * batches and their ids returned for the caller to drain. Never throws.
 */
export async function handleCoexistenceChange(
  db: SupabaseClient,
  field: CoexistenceField,
  value: unknown,
  config: CoexistenceConfig
): Promise<{ batchIds: string[] }> {
  const batchIds: string[] = [];
  try {
    if (field === 'smb_message_echoes') {
      await handleEchoes(db, value, config);
    } else if (field === 'history') {
      const { items, errorCodes } = parseHistoryItems(value);
      for (const code of errorCodes) {
        if (code === HISTORY_DECLINED_ERROR_CODE) {
          console.warn(
            '[webhook] history sharing declined:',
            JSON.stringify({ phoneNumberId: config.phone_number_id, code })
          );
        } else {
          console.warn(
            '[webhook] history error:',
            JSON.stringify({ phoneNumberId: config.phone_number_id, code })
          );
        }
      }
      for (const item of items) {
        const id = await queueHistoryItem(db, config, item);
        if (id) batchIds.push(id);
      }
    } else {
      const id = await queueStateSync(db, config, value);
      if (id) batchIds.push(id);
    }
  } catch (err) {
    console.error(
      '[webhook] coexistence change failed:',
      JSON.stringify({
        field,
        phoneNumberId: config.phone_number_id,
        error: errorMessage(err),
      })
    );
  }
  return { batchIds };
}

// ------------------------------------------------------------------
// account_update — PARTNER_REMOVED
// ------------------------------------------------------------------

export type DeliverySigner = 'platform' | 'tenant';
export interface DeliveryAuth {
  signer: DeliverySigner;
  rawBody: string;
  signature: string | null;
}

/**
 * The coexistence columns of migration 088 (#1650). Reset to NULL on a
 * partner removal so a later Embedded Signup asks Meta for both syncs
 * again instead of finding the old request ids (R44).
 */
export const COEXISTENCE_RESET_COLUMNS = {
  coexistence_onboarded_at: null,
  smb_state_sync_requested_at: null,
  smb_state_sync_request_id: null,
  smb_history_sync_requested_at: null,
  smb_history_sync_request_id: null,
  smb_sync_error: null,
} as const;

/**
 * An `account_update` change (`entry.id` = WABA id). Only
 * `PARTNER_REMOVED` writes: the WABA's rows that belong to whoever
 * signed the delivery go `disconnected`. Never throws.
 */
export async function handleAccountUpdate(
  db: SupabaseClient,
  wabaId: string,
  value: unknown,
  auth: DeliveryAuth
): Promise<void> {
  try {
    const v = asObject(value) ?? {};
    const event = asString(v.event);
    if (event !== 'PARTNER_REMOVED') {
      console.info(
        '[webhook] account_update:',
        JSON.stringify({ event: event ?? null, wabaId: wabaId || null })
      );
      return;
    }
    if (!wabaId) {
      console.warn('[webhook] partner removed without waba id; skipped');
      return;
    }
    const valueWabaId = asString(v.waba_id);
    if (valueWabaId && valueWabaId !== wabaId) {
      console.warn(
        '[webhook] partner removed: waba mismatch',
        JSON.stringify({ wabaId, valueWabaId })
      );
      return;
    }

    let targets: { id: string; account_id: string }[];
    if (auth.signer === 'platform') {
      const { data, error } = await db
        .from('whatsapp_config')
        .select('id, account_id')
        .eq('waba_id', wabaId)
        .is('app_secret', null);
      if (error) {
        console.error(
          '[webhook] partner removed: config lookup failed:',
          JSON.stringify({ wabaId, error: errorMessage(error) })
        );
        return;
      }
      targets = (data ?? []) as { id: string; account_id: string }[];
    } else {
      targets = await wabaConfigsSignedBy(
        db,
        wabaId,
        auth.rawBody,
        auth.signature
      );
    }

    let disconnected = 0;
    for (const row of targets) {
      const { error } = await db
        .from('whatsapp_config')
        .update({
          status: 'disconnected',
          updated_at: new Date().toISOString(),
          ...COEXISTENCE_RESET_COLUMNS,
        })
        .eq('id', row.id)
        .eq('account_id', row.account_id)
        .eq('waba_id', wabaId);
      if (error) {
        console.error(
          '[webhook] partner removed: update failed:',
          JSON.stringify({
            wabaId,
            configId: row.id,
            error: errorMessage(error),
          })
        );
      } else {
        disconnected += 1;
      }
    }

    console.warn(
      '[webhook] partner removed:',
      JSON.stringify({
        wabaId,
        signer: auth.signer,
        reason: asString(v.reason),
        initiatedBy: asString(v.initiated_by),
        disconnected,
      })
    );
  } catch (err) {
    console.error(
      '[webhook] account_update failed:',
      JSON.stringify({ wabaId, error: errorMessage(err) })
    );
  }
}
