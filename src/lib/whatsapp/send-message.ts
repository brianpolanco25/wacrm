// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import {
  resolveWhatsAppConfig,
  WhatsAppConfigError,
  type WhatsAppConfigRow,
} from '@/lib/whatsapp/resolve-config';
import {
  OutboundMediaError,
  resolveOutboundMedia,
  resolveTemplateHeaderMedia,
} from '@/lib/whatsapp/outbound-media';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils';
import {
  recipientAttempts,
  resolveRecipient,
  RecipientError,
  type MetaRecipient,
} from '@/lib/whatsapp/recipient';
import { assertQuota, recordUsage } from '@/lib/billing/enforce';
import type { MessageTemplate } from '@/types';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Remap a `WhatsAppConfigError` from the shared resolver onto this
 * module's error family, preserving both the machine code and the
 * status so callers keep behaving exactly as before.
 */
export function toSendMessageError(err: unknown): unknown {
  if (err instanceof WhatsAppConfigError) {
    return new SendMessageError(err.code, err.message, err.status);
  }
  return err;
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
  /**
   * Explicit sender number (fase 4 §1). Omitted by the inbox, which
   * has a conversation and therefore already knows its number; sent by
   * the "contact → send template" path, where no thread exists yet,
   * and by `/api/v1/messages` after translating its public `from`.
   */
  whatsAppConfigId?: string | null;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const {
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  } = params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  // Interactive: validate the full structured payload against Meta's
  // limits up front so a bad payload 400s before we touch Meta.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
    whatsAppConfigId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  // Fase 3 §4: `messages_out`. Checked BEFORE Meta is called — an
  // over-quota send that already reached the customer cannot be
  // un-sent — and counted at the very end, once the message is
  // persisted. Both callers of this core (`/api/whatsapp/send` and the
  // public `/api/v1/messages`) get it from here: a limit only the
  // dashboard honours is not a limit.
  await assertQuota(accountId, 'messages_out', 1);

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  // Teléfono si lo hay, BSUID si no (fase 6 §5). El resolutor es el
  // mismo que usan los motores de flujos y automatizaciones, para que
  // los cuatro caminos de salida no puedan discrepar sobre a quién se
  // le está escribiendo.
  let recipient;
  try {
    recipient = resolveRecipient(contact ?? {});
  } catch (err) {
    if (err instanceof RecipientError) {
      throw new SendMessageError(
        'bad_request',
        contact?.phone
          ? 'Invalid phone number format'
          : 'Contact phone number not found',
        400
      );
    }
    throw err;
  }

  // Which number does this go out through? (fase 4 §1). An explicit
  // `whatsAppConfigId` wins; otherwise the conversation's own number —
  // the one the customer wrote to — and only then the account default.
  // Dropping the UNIQUE(account_id) of 017 made the old `.single()`
  // here a PGRST116 waiting for the second number.
  let config: WhatsAppConfigRow;
  let accessToken: string;
  try {
    const resolved = await resolveWhatsAppConfig(db, {
      accountId,
      configId: whatsAppConfigId,
      conversationId,
      withToken: true,
    });
    config = resolved.row;
    accessToken = resolved.accessToken;
  } catch (err) {
    throw toSendMessageError(err);
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // Template row — needed for the send-builder's header + button
  // components AND for the body we persist. The lookup tolerates the
  // en / en_US split so a caller that omits the language still resolves
  // a row (see resolveTemplateRow).
  let templateRow: MessageTemplate | null = null;
  let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      templateName,
      templateLanguage
    );
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = resolved.row;
    sendLanguage = resolved.language;
  }

  // Attachments hosted in our own Storage go to Meta by media id — the
  // bytes are pulled with the service role and uploaded once per
  // (number, object), so the bucket no longer has to be public and Meta
  // never fetches from us at send time. External links pass through.
  // Resolved ONCE, outside the phone-variant retry, and scoped to
  // `accountId`: a caller cannot name another account's object.
  const mediaCtx = {
    accountId,
    phoneNumberId: config.phone_number_id as string,
    accessToken,
    storage: supabaseAdmin().storage,
    db: supabaseAdmin(),
  };
  let mediaRef: { mediaId: string } | { link: string } | null = null;
  let headerParams: SendTimeParams | undefined =
    (templateMessageParams as SendTimeParams | undefined) ?? undefined;
  try {
    if (isMediaKind) {
      mediaRef = await resolveOutboundMedia({
        ...mediaCtx,
        mediaUrl: mediaUrl!,
        fileName: filename,
      });
    } else if (messageType === 'template') {
      headerParams = await resolveTemplateHeaderMedia(
        templateRow,
        headerParams,
        mediaCtx
      );
    }
  } catch (err) {
    if (err instanceof OutboundMediaError) {
      throw new SendMessageError(
        err.code === 'forbidden' ? 'forbidden' : 'media_error',
        err.message,
        err.code === 'forbidden' ? 403 : 502
      );
    }
    throw err;
  }

  // Cada intento lleva el destinatario en el campo que toque (`to` o
  // `recipient`); el cuerpo del mensaje no cambia entre intentos.
  const attempt = async (target: MetaRecipient): Promise<string> => {
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        ...target,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: headerParams,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        ...target,
        kind: messageType as MediaKind,
        ...(mediaRef && 'mediaId' in mediaRef
          ? { mediaId: mediaRef.mediaId }
          : { link: mediaUrl! }),
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          ...target,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        phoneNumberId: config.phone_number_id,
        accessToken,
        ...target,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      ...target,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  // Send via Meta — retry across phone-number variants if Meta rejects
  // with "recipient not in allowed list"; persist a working variant
  // back to the contact so the next send goes straight through. Por
  // BSUID hay un único intento: el id es exacto y no admite variantes.
  let waMessageId = '';
  let workingTarget: MetaRecipient | null = null;
  try {
    const attempts = recipientAttempts(recipient);
    let lastError: unknown = null;

    for (const target of attempts) {
      try {
        waMessageId = await attempt(target);
        workingTarget = target;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(
          `[send-message] variant "${target.to ?? target.recipient}" rejected by Meta, trying next…`
        );
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[send-message] Meta send failed for all variants:', message);
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  if (
    recipient.kind === 'phone' &&
    workingTarget?.to &&
    workingTarget.to !== recipient.phone
  ) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${recipient.phone} → ${workingTarget.to}`
    );
    await db
      .from('contacts')
      .update({ phone: workingTarget.to })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  //
  // Templates persist the *substituted* body. The composer pre-renders
  // and posts it as contentText; every other caller (the public API,
  // most importantly) sends none, and storing null there left the
  // Inbox rendering an empty bubble — issue #483.
  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  // Counted only now: the message reached Meta AND is on record.
  // Best-effort inside `recordUsage` — a counter that did not move must
  // not turn a delivered message into an error for the operator.
  await recordUsage(accountId, 'messages_out', 1);

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
