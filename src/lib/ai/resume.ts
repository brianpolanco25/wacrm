import type { ChatMessage } from './types';
import { DEFAULT_HANDOFF_MESSAGE } from './handoff-message';

export interface ResumedContext {
  /** The transcript with every hand-off notice removed. */
  messages: ChatMessage[];
  /** True when at least one notice was removed — i.e. the bot handed
   *  this thread off earlier and a human has since returned it. */
  resumedAfterHandoff: boolean;
}

/**
 * Remove the bot's own hand-off notices from the transcript the model
 * is about to read, and report whether any were there.
 *
 * The notice («Thanks for writing to us. A member of our team will
 * continue this conversation shortly.», or whatever the account
 * configured) is stored as an ordinary bot message, so
 * `buildConversationContext` feeds it back as an `assistant` turn. That
 * is poison once a human hands the thread back to the bot: the model
 * reads a transcript in which "it" already promised a person would
 * follow up, the customer wrote again, and nothing happened — and the
 * cheapest continuation is to repeat the promise, which in auto-reply
 * mode means emitting the sentinel and handing off *again*. Observed
 * in production as a loop: every «Hola» after a resume produced another
 * notice.
 *
 * Matching is by text, whitespace-normalised, against the configured
 * message AND the shipped default (an account that edited the message
 * still has older notices in its threads). Only `assistant` turns are
 * candidates — a customer quoting the notice back is still a customer
 * message.
 */
export function stripHandoffNotices(
  messages: ChatMessage[],
  handoffMessage: string | null | undefined
): ResumedContext {
  const notices = new Set<string>();
  for (const candidate of [handoffMessage, DEFAULT_HANDOFF_MESSAGE]) {
    const key = normalise(candidate ?? '');
    if (key) notices.add(key);
  }

  let removed = 0;
  const kept = messages.filter((m) => {
    if (m.role !== 'assistant') return true;
    if (!notices.has(normalise(m.content))) return true;
    removed += 1;
    return false;
  });

  return { messages: kept, resumedAfterHandoff: removed > 0 };
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
