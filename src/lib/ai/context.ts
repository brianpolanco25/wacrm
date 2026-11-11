import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'
import { formatVoiceNote } from './voice/config'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  /** Absent only in reads mocked before n15.1; treated as text. */
  content_type?: string | null
  content_text: string | null
  transcript?: string | null
  transcript_status?: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model —
 * except a customer voice note already transcribed (n15.1, R25): it is a
 * `user` turn `[nota de voz] <transcript>` flagged `voice`. An audio with
 * no transcript is filtered in the query, so it takes no slot of `limit`.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, transcript, transcript_status')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio'])
    .or('content_type.eq.text,transcript_status.eq.done')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const out: ChatMessage[] = []
  for (const m of rows) {
    if (m.content_type === 'audio') {
      const transcript = m.transcript?.trim()
      if (
        m.sender_type === 'customer' &&
        m.transcript_status === 'done' &&
        transcript
      ) {
        out.push({
          role: 'user',
          content: formatVoiceNote(transcript),
          voice: true,
        })
      }
      continue
    }
    if (!m.content_text || !m.content_text.trim()) continue
    out.push({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text.trim(),
    })
  }
  return out
}
