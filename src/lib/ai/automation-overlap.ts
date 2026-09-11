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
 * Triggers that fire on the CONTENT of an inbound message, i.e. the ones
 * that compete with the AI auto-reply for the same event. Relationship
 * triggers (`new_contact_created`, `first_inbound_message`, `tag_added`,
 * …) are about WHO is writing, not what they said, so an automation on
 * one of those doesn't overlap.
 *
 * `interactive_reply` is not here either: the AI auto-reply only runs
 * for plain text (the webhook skips it when a button/list reply
 * arrives), so the two can never collide.
 */
export const MESSAGE_LEVEL_TRIGGERS = [
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
 * The active automations that answer on message content.
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
      MESSAGE_LEVEL_TRIGGERS.includes(
        a.trigger_type as (typeof MESSAGE_LEVEL_TRIGGERS)[number]
      )
  );
}
