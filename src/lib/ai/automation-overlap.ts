/**
 * Which automations can answer the same inbound message the AI agent
 * would answer — the safety net of fase 1 §4.
 *
 * The guard itself is now per message: an automation only silences the
 * bot for the one inbound it actually replied to (migration 051). That
 * is the right behaviour, but it is also invisible — the admin who
 * writes a keyword automation for "opening hours" has no way to tell
 * that some of their AI replies are being pre-empted. Settings → AI
 * shows this list so the overlap is a visible, deliberate choice
 * instead of a silent one.
 */

/**
 * The triggers whose automations can answer the very inbound message the
 * AI agent would have answered — i.e. the ones that can take the
 * per-message reservation out from under it (migration 051).
 *
 * These are exactly the triggers the webhook dispatches with
 * `inbound_message_id` in the context AND that a customer message sets
 * off, in the order the webhook fires them. The relationship ones are
 * here on purpose, despite being about WHO is writing rather than what
 * they said: a welcome automation on `new_contact_created` /
 * `first_inbound_message` answers the customer's first message, so for
 * that message the bot does stand down. Leaving them out made the notice
 * claim the opposite in exactly the account most likely to hit it — a
 * brand-new contact's first "hi".
 *
 * Deliberately not here:
 *   - `interactive_reply`: the AI auto-reply only runs for plain text
 *     (the webhook skips it when a button/list reply arrives), so the
 *     two can never collide.
 *   - `tag_added` and the other engine-chained triggers: they can carry
 *     an inbound along a chain (a keyword automation that adds a tag),
 *     but they never fire from a customer message on their own, and
 *     flagging every tag automation would drown the notice in noise.
 */
export const OVERLAPPING_TRIGGERS = [
  'first_inbound_message',
  'new_contact_created',
  'new_message_received',
  'keyword_match',
] as const;

export interface OverlapCandidate {
  id: string;
  name?: string | null;
  trigger_type?: string | null;
  is_active?: boolean | null;
}

/**
 * The active automations that can answer an inbound message before the
 * AI agent does.
 *
 * Pure and defensive about the shape: it is fed straight from
 * `GET /api/automations`, whose rows come from the database and may
 * predate any given column.
 */
export function overlappingAutomations<T extends OverlapCandidate>(
  automations: readonly T[] | null | undefined
): T[] {
  if (!automations) return [];
  return automations.filter(
    (a) =>
      a?.is_active === true &&
      OVERLAPPING_TRIGGERS.includes(
        a.trigger_type as (typeof OVERLAPPING_TRIGGERS)[number]
      )
  );
}
