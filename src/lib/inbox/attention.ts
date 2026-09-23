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
// (`assigned_agent_id`, `ai_autoreply_disabled`, `status`) plus ONE
// account-wide flag the thread banner already fetches and caches. No
// per-conversation query is added anywhere.
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
  'assigned_agent_id' | 'ai_autoreply_disabled' | 'status'
>;

/**
 * Derive who is attending a conversation. `null` means "no state to
 * show": either it can't be decided yet, or there is nothing to act on.
 *
 * `accountAiOn` is the account-level "auto-reply is live" flag
 * (configured + master switch + inbound bot), the same value the thread
 * banner uses to decide whether to render at all. Three values, and the
 * third one matters:
 *
 *   - `true`  → the account has a bot.
 *   - `false` → it doesn't, so `"ai"` can never be returned and an
 *               untouched or handed-off thread reads as unattended.
 *   - `null`  → **unknown** (still in flight, or `/api/ai/config`
 *               failed). The AI/unattended split can't be decided, and
 *               guessing paints the amber alarm on every chat the bot is
 *               quietly handling. So: no state. The guard lives here, in
 *               the one place, so the badge and the "Unattended" filter
 *               cannot drift apart.
 *
 * A human assignee wins over the bot and is knowable without the flag:
 * the bot doesn't run on a thread a human owns (see `auto-reply.ts`),
 * and even if the pause flag hadn't been written yet, "Operator X" is
 * the state the team must act on.
 *
 * A **closed** thread is out of the work queue: it gets no "nobody on
 * it" alarm. An account with the assistant off and 800 closed chats
 * would otherwise light up its whole history in amber.
 *
 * `teamSize` is how many members the account has (its `profiles`
 * rows). "Nobody on it" only means something where there is someone to
 * hand the chat to (p8.2): in a one-person account every unassigned
 * chat is, by definition, that person's, and the amber alarm on all of
 * them is noise. It only gates the `'unattended'` outcome — `assigned`
 * and `ai` are knowable without it — and, like `accountAiOn`, `null`
 * means **unknown** (profiles still in flight, or the read failed), so
 * nothing is decided rather than flashing amber while it loads.
 */
export function deriveAttentionState(
  conversation: AttentionInput,
  accountAiOn: boolean | null,
  teamSize: number | null
): AttentionState | null {
  if (conversation.assigned_agent_id) return 'assigned';
  if (accountAiOn === null) return null;
  if (accountAiOn && !conversation.ai_autoreply_disabled) return 'ai';
  if (conversation.status === 'closed') return null;
  if (teamSize === null || teamSize <= 1) return null;
  return 'unattended';
}

/**
 * Whether the "Unattended" filter chip is offered at all: hidden only
 * when the account is KNOWN to have a single member. While the team
 * size is unknown the chip stays (it simply lists nothing, see above)
 * rather than blinking in and out as profiles land.
 */
export function offersUnattendedFilter(teamSize: number | null): boolean {
  return teamSize === null || teamSize >= 2;
}

/**
 * The "Unattended" header filter: no operator **and** no AI. Includes
 * the handed-off threads nobody picked up (`ai_autoreply_disabled` with
 * a null assignee) — those are precisely the ones the filter exists for.
 * Excludes the closed ones (a work queue, not a history listing) and,
 * while the account's AI status or team size is unknown, decides
 * nothing. Empty for a one-person account.
 */
export function isUnattended(
  conversation: AttentionInput,
  accountAiOn: boolean | null,
  teamSize: number | null
): boolean {
  return (
    deriveAttentionState(conversation, accountAiOn, teamSize) === 'unattended'
  );
}
