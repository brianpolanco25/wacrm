// ============================================================
// Public API (v1) serializers for conversations + messages.
//
// The dashboard's `Conversation`/`Message` rows carry internal columns
// (account_id, user_id, sender_id) that shouldn't leak onto the public
// wire. These serializers project the stable public subset and rename
// the Meta id (`message_id` → `whatsapp_message_id`) to match the send
// endpoint's response vocabulary.
//
// n15.5 (Cabbity Health chat): the conversation also reports the 24 h
// service window and the AI state, and the message the member who sent
// it plus a short-lived signed URL for its attachment.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  assertStoragePathOwnedBy,
  parseStorageObjectUrl,
  MEDIA_BUCKETS,
} from '@/lib/media/storage-url';
import { SIGNED_URL_TTL_SECONDS } from '@/lib/media/signed-url';
import type { Conversation, Message } from '@/types';

/** WhatsApp's customer-service window: 24 h after the last inbound message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ApiConversationAi {
  /** AI + auto-reply on for the account, no pause here and nobody assigned. */
  active: boolean;
  /** The bot was paused on this thread (a person took over or it handed off). */
  paused: boolean;
  handoff_summary: string | null;
}

export interface ApiConversation {
  id: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  /** Only on list / read / PATCH (not in exports). */
  last_inbound_at?: string | null;
  /** `last_inbound_at + 24 h`, or null when the contact never wrote. */
  service_window_expires_at?: string | null;
  ai?: ApiConversationAi;
  contact: {
    id: string;
    /** Null cuando el contacto solo se identifica por su BSUID. */
    phone: string | null;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

export interface ApiMessageMedia {
  url: string;
  mime_type: string | null;
  filename: string | null;
  expires_at: string;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  /** `messages.sender_id` when an account member sent it (`sender_type = agent`). */
  sender_member_id: string | null;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  /** Signed URL (10 min) for our own storage objects; null otherwise. */
  media: ApiMessageMedia | null;
  template_name: string | null;
  whatsapp_message_id: string | null;
  status: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  created_at: string;
}

export interface ConversationSerializeOptions {
  /** `ai_configs.is_active && auto_reply_enabled` of the account. */
  accountAiOn: boolean;
}

/**
 * Whether the account's AI auto-reply is on (one query per request).
 * Always filtered by `account_id`.
 */
export async function loadAccountAiOn(
  db: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('ai_configs')
    .select('is_active, auto_reply_enabled')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return false;
  const row = data as { is_active?: boolean; auto_reply_enabled?: boolean };
  return Boolean(row.is_active && row.auto_reply_enabled);
}

/** `last_inbound_at + 24 h` as ISO, or null. */
export function serviceWindowExpiresAt(
  lastInboundAt: string | null | undefined
): string | null {
  if (!lastInboundAt) return null;
  const ts = Date.parse(lastInboundAt);
  if (Number.isNaN(ts)) return null;
  return new Date(ts + SERVICE_WINDOW_MS).toISOString();
}

/**
 * Project a normalized `Conversation` (from `normalizeConversation`,
 * which has already flattened `contact.tags`) into the public shape.
 * With `opts`, also the window and AI fields (list / read / PATCH).
 */
export function serializeConversation(
  conv: Conversation,
  opts?: ConversationSerializeOptions
): ApiConversation {
  const c = conv.contact;
  const base: ApiConversation = {
    id: conv.id,
    contact_id: conv.contact_id,
    status: conv.status,
    assigned_agent_id: conv.assigned_agent_id ?? null,
    last_message_text: conv.last_message_text ?? null,
    last_message_at: conv.last_message_at ?? null,
    unread_count: conv.unread_count ?? 0,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    contact: c
      ? {
          id: c.id,
          phone: c.phone ?? null,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: (c.tags ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
          })),
        }
      : null,
  };
  if (!opts) return base;

  const lastInbound =
    (conv as unknown as { last_inbound_at?: string | null }).last_inbound_at ??
    null;
  const paused = Boolean(conv.ai_autoreply_disabled);
  return {
    ...base,
    last_inbound_at: lastInbound,
    service_window_expires_at: serviceWindowExpiresAt(lastInbound),
    ai: {
      active: opts.accountAiOn && !paused && !conv.assigned_agent_id,
      paused,
      handoff_summary: conv.ai_handoff_summary ?? null,
    },
  };
}

/** Project a `messages` row into the public shape (`media` filled by `serializeMessagesWithMedia`). */
export function serializeMessage(m: Message): ApiMessage {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    // `customer` = inbound (from the contact); anything else is outbound.
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    sender_member_id: m.sender_type === 'agent' ? (m.sender_id ?? null) : null,
    content_type: m.content_type,
    content_text: m.content_text ?? null,
    media_url: m.media_url ?? null,
    media: null,
    template_name: m.template_name ?? null,
    whatsapp_message_id: m.message_id ?? null,
    status: m.status,
    reply_to_message_id: m.reply_to_message_id ?? null,
    interactive_reply_id: m.interactive_reply_id ?? null,
    created_at: m.created_at,
  };
}

function filenameOf(path: string): string | null {
  const last = path.split('/').pop() ?? '';
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Sign the attachment of one message, or null. Only objects of OUR media
 * buckets under `account-<accountId>/` are signed (service role): a URL
 * pointing at another account's folder, an external link or a legacy
 * `<uid>/…` path yields null, never a signed URL.
 */
export async function signMessageMedia(
  db: SupabaseClient,
  accountId: string,
  m: Pick<Message, 'media_url' | 'media_type'>
): Promise<ApiMessageMedia | null> {
  if (!m.media_url) return null;
  const ref = parseStorageObjectUrl(m.media_url, {
    origin: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
  });
  if (!ref || !MEDIA_BUCKETS.has(ref.bucket)) return null;
  try {
    const owner = assertStoragePathOwnedBy(ref, accountId);
    if (owner.kind !== 'account') return null;
  } catch {
    return null;
  }
  try {
    const issuedAt = Date.now();
    const { data, error } = await db.storage
      .from(ref.bucket)
      .createSignedUrl(ref.path, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    return {
      url: data.signedUrl,
      mime_type: m.media_type ?? null,
      filename: filenameOf(ref.path),
      expires_at: new Date(
        issuedAt + SIGNED_URL_TTL_SECONDS * 1000
      ).toISOString(),
    };
  } catch (err) {
    console.warn(
      '[api/v1] could not sign message media:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Serialize a batch of messages, signing the attachments of `accountId` only. */
export async function serializeMessagesWithMedia(
  db: SupabaseClient,
  accountId: string,
  rows: Message[]
): Promise<ApiMessage[]> {
  return Promise.all(
    rows.map(async (m) => ({
      ...serializeMessage(m),
      media: await signMessageMedia(db, accountId, m),
    }))
  );
}
