import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Who reserved the single automatic reply to an inbound message.
 * Mirrors the CHECK constraint of migration 051.
 */
export type AutoResponder = 'automation' | 'ai';

export interface ClaimArgs {
  /** Tenancy key. `inbound_auto_replies` has no RLS, so every write and
   *  read through the service role carries the account explicitly. */
  accountId: string;
  /** The internal `messages.id` of the inbound the customer just sent —
   *  NOT Meta's `wamid`. It is the primary key of the reservation. */
  messageId: string;
  responder: AutoResponder;
  /** Audit only: which automation reserved it. */
  automationId?: string | null;
}

/**
 * Reserve the one automatic reply to an inbound message.
 *
 * Both automatic responders — the automation engine and the AI
 * auto-reply — call this BEFORE they send. The primary key on
 * `message_id` (migration 051) makes Postgres pick exactly one winner,
 * so "the customer never gets two automatic replies to the same message"
 * holds regardless of the order or the interleaving of the two
 * dispatches.
 *
 * Modelled on the webhook's own idempotent inbound insert: an upsert
 * with `ignoreDuplicates` turns the PK conflict into ON CONFLICT DO
 * NOTHING, and the `.select()` comes back empty exactly when somebody
 * else already owns the reply.
 *
 * @returns `true` when this caller won the reservation and may send.
 *
 * Fails closed: any database error resolves to `false` (don't send).
 * Losing a reply is annoying; texting the customer twice is the bug this
 * whole feature exists to prevent. The error is logged loudly because
 * "auto-reply never fires" is otherwise undiagnosable — that is the same
 * reasoning as the `claim_ai_reply_slot` error branch.
 */
export async function claimInboundAutoReply(
  db: SupabaseClient,
  args: ClaimArgs
): Promise<boolean> {
  const { data, error } = await db
    .from('inbound_auto_replies')
    .upsert(
      {
        message_id: args.messageId,
        account_id: args.accountId,
        responder: args.responder,
        automation_id: args.automationId ?? null,
      },
      { onConflict: 'message_id', ignoreDuplicates: true }
    )
    .select('message_id');

  if (error) {
    console.error(
      '[auto-reply guard] could not reserve the reply for inbound message',
      args.messageId,
      error
    );
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * The automation engine's version of the reservation: reserve the reply,
 * and also answer "…or was it already mine?".
 *
 * The engine HONOURS the result — a run that loses the reservation does
 * not send — but it must not stand down in front of itself. Two
 * perfectly normal cases lose the plain `claimInboundAutoReply` while
 * still being the rightful owner:
 *
 *   - a run whose steps send several messages (only the first insert
 *     wins; the rest conflict with the run's own row);
 *   - the tail of a run that was parked on a `wait` step and resumed
 *     minutes later by the cron — the reservation it took before the
 *     wait is still sitting there.
 *
 * So a lost reservation is checked against its holder: only this
 * automation's own row counts as "still ours". Anything else — the AI,
 * or a different automation — means somebody already answered this
 * inbound and this run must not send a second reply.
 *
 * The follow-up read is safe because `ON CONFLICT DO NOTHING` waits for
 * the concurrent inserter to commit or roll back before it reports the
 * conflict: by the time we get here the winning row is visible.
 *
 * @returns `true` when this automation may send.
 *
 * Fails closed, like the claim it wraps: a read error resolves to
 * `false`.
 */
export async function claimInboundAutoReplyForAutomation(
  db: SupabaseClient,
  args: ClaimArgs & { automationId: string }
): Promise<boolean> {
  const won = await claimInboundAutoReply(db, {
    ...args,
    responder: 'automation',
  });
  if (won) return true;

  const { data, error } = await db
    .from('inbound_auto_replies')
    .select('responder, automation_id')
    .eq('message_id', args.messageId)
    // Tenancy: service-role client, so the account is filtered here and
    // not by RLS. A row belonging to another account is not ours either
    // way, and `maybeSingle` resolving null keeps us quiet.
    .eq('account_id', args.accountId)
    .maybeSingle();

  if (error) {
    console.error(
      '[auto-reply guard] could not read the holder of the reservation for inbound message',
      args.messageId,
      error
    );
    return false;
  }

  return (
    data?.responder === 'automation' &&
    data?.automation_id === args.automationId
  );
}
