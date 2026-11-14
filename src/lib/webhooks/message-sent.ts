// ============================================================
// Evento `message.sent`: un saliente de una conversación quedó guardado.
//
// Un solo emisor para los cuatro orígenes (panel y API por
// `send-message.ts`, IA y flujos/automatizaciones por sus `meta-send`),
// para que el `data` no pueda discrepar. NO se emite por cada
// destinatario de una difusión: las difusiones no pasan por aquí.
//
// Nunca lanza (`emitWebhookEvent`): un webhook caído no puede convertir
// un mensaje ya entregado a Meta en un error para quien lo envió.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { emitWebhookEvent } from '@/lib/webhooks/emit';

export async function emitMessageSent(
  accountId: string,
  m: {
    conversationId: string;
    /** `messages.id` de la fila guardada (null si no se pudo leer). */
    messageId: string | null;
    whatsappMessageId: string | null;
    senderType: 'agent' | 'bot';
    /** Miembro que lo envió; solo existe para `agent` enviado por la API. */
    senderMemberId?: string | null;
    contentType: string;
  }
): Promise<void> {
  await emitWebhookEvent(accountId, 'message.sent', {
    conversation_id: m.conversationId,
    message_id: m.messageId,
    whatsapp_message_id: m.whatsappMessageId,
    sender_type: m.senderType,
    sender_member_id: m.senderMemberId ?? null,
    content_type: m.contentType,
  });
}

/**
 * `message.sent` para los envíos del bot (IA, flujos, automatizaciones),
 * que insertan la fila sin leerla de vuelta: aquí se resuelve su
 * `messages.id` por (conversación, wamid). Todo va dentro de un `try`:
 * un fallo de lectura o de entrega nunca afecta al envío.
 */
export async function emitBotMessageSent(
  db: SupabaseClient,
  accountId: string,
  m: {
    conversationId: string;
    whatsappMessageId: string;
    contentType: string;
  }
): Promise<void> {
  try {
    const { data } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', m.conversationId)
      .eq('message_id', m.whatsappMessageId)
      .order('created_at', { ascending: false })
      .limit(1);
    const id =
      Array.isArray(data) && data[0]
        ? ((data[0] as { id: string }).id ?? null)
        : null;
    await emitMessageSent(accountId, {
      conversationId: m.conversationId,
      messageId: id,
      whatsappMessageId: m.whatsappMessageId,
      senderType: 'bot',
      contentType: m.contentType,
    });
  } catch (err) {
    console.error(
      '[webhooks] message.sent (bot) failed:',
      err instanceof Error ? err.message : err
    );
  }
}
