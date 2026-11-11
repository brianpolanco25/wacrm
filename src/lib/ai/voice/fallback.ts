import type { SupabaseClient } from '@supabase/supabase-js';
import { engineSendText } from '@/lib/flows/meta-send';
import { checkRateLimit } from '@/lib/rate-limit';
import { fitWhatsAppText } from '@/lib/whatsapp/text-limit';
import { aiVoiceFallbackCooldownMs } from './config';

export type VoiceFallbackResult =
  'sent' | 'opted_out' | 'cooldown' | 'send_failed';

export interface SendVoiceFallbackArgs {
  /** Service-role client. */
  db: SupabaseClient;
  accountId: string;
  /** Already verified against `account_id` by the dispatcher (R32). */
  conversationId: string;
  contactId: string;
  /** Audit user for the outbound (`configOwnerUserId`), as the handoff notice. */
  userId: string;
  /** The voice note's id — only for the log line. */
  messageId: string;
  /** `AiConfig.voiceFallbackMessage`. */
  text: string | null | undefined;
  deps?: {
    send?: typeof engineSendText;
    limiter?: typeof checkRateLimit;
    now?: () => number;
  };
}

/**
 * n15.1 (D3, R28, R29, R41, R42): tell the customer we could not listen
 * to their voice note and ask them to type. The AI stays on: this does
 * NOT touch `conversations`, claim a reply slot or count `ai_replies` —
 * it is an acknowledgement, like the handoff notice.
 *
 * At most one per conversation per cooldown window (10 min by default):
 * a durable check (a bot message with the same text inside the window)
 * and an in-process limiter that closes the race of two voice notes that
 * pass the durable check together. Never throws; never logs the text.
 */
export async function sendVoiceFallback(
  args: SendVoiceFallbackArgs
): Promise<VoiceFallbackResult> {
  const { db, accountId, conversationId, contactId, userId, messageId } = args;
  const send = args.deps?.send ?? engineSendText;
  const limiter = args.deps?.limiter ?? checkRateLimit;
  const now = args.deps?.now ?? Date.now;

  const done = (result: VoiceFallbackResult) => {
    console.info(`[ai voice] message ${messageId} fallback ${result}`);
    return result;
  };

  try {
    const trimmed = args.text?.trim();
    if (!trimmed) return done('opted_out'); // R41

    // Exactly what `engineSendText` stores as `content_text`, so the
    // durable check below compares like with like.
    const fitted = fitWhatsAppText(trimmed).text;
    const cooldownMs = aiVoiceFallbackCooldownMs();

    // Durable anti-loop (R29). A read error fails open: one text too many
    // is better than a customer left without any answer.
    try {
      const { data, error } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'bot')
        .eq('content_text', fitted)
        .gte('created_at', new Date(now() - cooldownMs).toISOString())
        .limit(1);
      if (!error && Array.isArray(data) && data.length > 0) {
        return done('cooldown');
      }
    } catch {
      // fail open
    }

    // In-process anti-loop: two simultaneous voice notes.
    const slot = limiter(`ai-voice-fallback:${conversationId}`, {
      limit: 1,
      windowMs: cooldownMs,
    });
    if (!slot.success) return done('cooldown');

    try {
      await send({
        accountId,
        userId,
        conversationId,
        contactId,
        text: fitted,
        aiGenerated: true,
      });
    } catch (err) {
      console.error(
        `[ai voice] message ${messageId} fallback send failed: ${err instanceof Error ? err.name : 'unknown error'}`
      );
      return done('send_failed'); // R42
    }
    return done('sent');
  } catch (err) {
    console.error(
      `[ai voice] message ${messageId} fallback crashed: ${err instanceof Error ? err.name : 'unknown error'}`
    );
    return 'send_failed';
  }
}
