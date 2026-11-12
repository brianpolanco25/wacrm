import type { ChatMessage } from './types'
import { stripVoiceNoteMarker } from './voice/config'
import { stripImageMarker } from './images/config'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 * A voice-note turn is searched without its `[nota de voz]` marker
 * (n15.1, R27): the marker is prompt framing, not what the customer said.
 * Same for an image turn (n15.2, R15): its caption, `''` without one.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') {
      if (m.image) return stripImageMarker(m.content)
      return m.voice ? stripVoiceNoteMarker(m.content) : m.content
    }
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}
