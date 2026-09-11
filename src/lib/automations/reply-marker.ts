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
