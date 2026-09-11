import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './admin-client';
import { loadAiConfig } from './config';
import { buildConversationContext } from './context';
import { retrieveKnowledge } from './knowledge';
import { generateReply } from './generate';
import { buildSystemPrompt } from './defaults';
import { buildHandoffSummary } from './handoff';
import { logAiUsage } from './usage';
import { latestUserMessage } from './query';
import { engineSendText } from '@/lib/flows/meta-send';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { claimInboundAutoReply } from '@/lib/automations/reply-marker';
import type { AiConfig } from './types';

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string;
  conversationId: string;
  contactId: string;
  /** Internal `messages.id` of the inbound we are reacting to. It is the
   *  key of the per-message reservation that decides whether an
   *  automation already answered THIS message (fase 1, §4). */
  inboundMessageId: string;
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string;
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - an automation already answered THIS inbound message
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args;

  try {
    const db = supabaseAdmin();

    const config = await loadAiConfig(db, accountId);
    if (!config || !config.autoReplyEnabled) return;

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convErr || !conv) return;
    if (conv.assigned_agent_id) return; // a human owns this thread
    if (conv.ai_autoreply_disabled) return; // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return;

    // Deterministic, user-configured responders win over the LLM. The
    // caller already excludes messages a Flow consumed; message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched for this same inbound, just before us in the webhook's
    // `after()` block, and reserve the reply before they send.
    //
    // This used to be an account-wide guard — "the account has an active
    // keyword automation, therefore the bot is mute everywhere" — which
    // turned one automation answering "opening hours" into a silent
    // company-wide outage of the AI agent. Now the question is asked per
    // message, and asking it IS taking the reservation: whoever inserts
    // the `inbound_auto_replies` row first is the only one that talks
    // (migration 051). Losing means an automation answered this message,
    // or another dispatch of the same inbound got here first — either
    // way we stay quiet, including the handoff notice below, because
    // that would be a second automatic message about the same inbound.
    //
    // Placed after the cheap gates (so an owned or paused thread writes
    // no rows) and before the model call (so a message an automation
    // already answered costs nothing).
    const won = await claimInboundAutoReply(db, {
      accountId,
      messageId: args.inboundMessageId,
      responder: 'ai',
    });
    if (!won) return;

    const messages = await buildConversationContext(db, conversationId);
    if (messages.length === 0) return;

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount
    );
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`
      );
      return;
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages)
    );

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    });

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    });

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    });

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation per the
      // account's handoff mode — a fixed agent, the least-loaded online
      // agent, or nobody (shared queue) — and (c) leave a short internal
      // note so whoever picks it up has context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      });
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      };
      // Only set the assignee when the thread isn't already owned — never
      // stomp an existing human assignment — and only when the configured
      // mode resolves to somebody (a null target means "shared queue").
      if (!conv.assigned_agent_id) {
        const target = await resolveHandoffTarget(db, accountId, config);
        if (target) update.assigned_agent_id = target;
      }
      // Conditional on the flag we are flipping, and asking for the
      // affected rows back. That makes this the handoff's equivalent of
      // `claim_ai_reply_slot`: exactly one concurrent dispatch can win.
      // Two inbounds a second apart both read `ai_autoreply_disabled =
      // false` and both reach here; without the predicate both would
      // also send the notice and the customer would get it twice.
      const { data: handedOff, error: handoffErr } = await db
        .from('conversations')
        .update(update)
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .eq('ai_autoreply_disabled', false)
        .select('id');

      if (handoffErr) {
        // supabase-js resolves with `{ error }` instead of throwing, so a
        // lost UPDATE used to be invisible. It no longer is: with the
        // flag still false the next inbound hands off again and re-sends
        // the notice, so the customer sees the failure. Loud log, no
        // send — the inbound is still in the inbox for a human.
        console.error(
          '[ai auto-reply] handoff write failed — not sending the transition message:',
          handoffErr
        );
        return;
      }
      if (!handedOff || handedOff.length === 0) {
        // Somebody else (a concurrent dispatch, or an agent who turned
        // the bot off from the thread) already owns the handoff. It is
        // done; ours would only duplicate the notice.
        return;
      }

      // Tell the customer a person is taking over, so the thread doesn't
      // just go silent from their side. Deliberately AFTER the handoff
      // write: losing the notice is annoying, losing the assignment is
      // serious. It is an acknowledgement, not a reply — it does NOT
      // claim a reply slot and does NOT count towards `ai_replies`.
      // An empty message means the account opted out of the notice.
      const handoffMessage = config.handoffMessage?.trim();
      if (handoffMessage) {
        try {
          await engineSendText({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text: handoffMessage,
            aiGenerated: true,
          });
        } catch (err) {
          console.error(
            '[ai auto-reply] handoff message failed to send (conversation handed off anyway):',
            err
          );
        }
      }
      return;
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      }
    );
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr);
      return;
    }
    if (claimed !== true) return; // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    });
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err);
  }
}

/**
 * Who the handoff goes to, per `ai_configs.handoff_mode` (migration 043):
 *   - `fixed` → the configured agent (may be null if it was never set)
 *   - `auto`  → the least-loaded online member, via `pick_available_agent`
 *               (migration 042). NULL is a valid answer — nobody is online
 *               — and so is an RPC error: both degrade to the queue, because
 *               losing the assignment is worse than leaving it unassigned
 *               where any agent can pick it up.
 *   - `queue` → nobody.
 */
async function resolveHandoffTarget(
  db: SupabaseClient,
  accountId: string,
  config: AiConfig
): Promise<string | null> {
  switch (config.handoffMode) {
    case 'fixed':
      return config.handoffAgentId;
    case 'auto': {
      const { data, error } = await db.rpc('pick_available_agent', {
        p_account_id: accountId,
      });
      if (error) {
        console.error(
          '[ai auto-reply] pick_available_agent failed — leaving the thread in the queue:',
          error
        );
        return null;
      }
      return typeof data === 'string' && data ? data : null;
    }
    default:
      return null;
  }
}
