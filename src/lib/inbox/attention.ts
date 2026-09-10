import type { Conversation } from '@/types';

// ============================================================
// Who is attending a conversation (fase 1 §3).
//
// Before this, a thread the AI was handling looked exactly like a
// thread nobody had ever touched, and like one the AI handed off that
// no human picked up — `assigned_agent_id` is NULL in all three. The
// third case is the one that dies in silence, so the inbox list needs
// to tell them apart.
//
// Pure on purpose: everything it needs already travels with the row
// (`assigned_agent_id`, `ai_autoreply_disabled`) plus ONE account-wide
// flag the thread banner already fetches and caches. No per-conversation
// query is added anywhere.
// ============================================================

/** The three states a row can be in. */
export type AttentionState =
  /** The account's bot is live and this thread isn't paused. */
  | 'ai'
  /** A human owns it (`assigned_agent_id`). */
  | 'assigned'
  /** Nobody: no assignee, and the bot isn't answering here. */
  | 'unattended';

/** The subset of a conversation the derivation reads. */
export type AttentionInput = Pick<
  Conversation,
  'assigned_agent_id' | 'ai_autoreply_disabled'
>;

/**
 * Derive who is attending a conversation.
 *
 * `accountAiOn` is the account-level "auto-reply is live" flag
 * (configured + master switch + inbound bot), the same value the thread
 * banner uses to decide whether to render at all. With it false the
 * account has no bot, so `"ai"` can never be returned — a handed-off or
 * untouched thread reads as unattended, which is the truth.
 *
 * A human assignee wins over the bot: the bot doesn't run on a thread a
 * human owns (see `auto-reply.ts`), and even if the pause flag hadn't
 * been written yet, "Operator X" is the state the team must act on.
 */
export function deriveAttentionState(
  conversation: AttentionInput,
  accountAiOn: boolean
): AttentionState {
  if (conversation.assigned_agent_id) return 'assigned';
  if (accountAiOn && !conversation.ai_autoreply_disabled) return 'ai';
  return 'unattended';
}

/**
 * The "Unattended" header filter: no operator **and** no AI. Includes
 * the handed-off threads nobody picked up (`ai_autoreply_disabled` with
 * a null assignee) — those are precisely the ones the filter exists for.
 */
export function isUnattended(
  conversation: AttentionInput,
  accountAiOn: boolean
): boolean {
  return deriveAttentionState(conversation, accountAiOn) === 'unattended';
}
