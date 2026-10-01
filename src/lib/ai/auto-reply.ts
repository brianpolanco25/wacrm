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
import { fitWhatsAppText } from '@/lib/whatsapp/text-limit';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { claimInboundAutoReply } from '@/lib/automations/reply-marker';
import {
  assertWritable,
  assertPlanFeature,
  assertQuota,
  recordUsage,
} from '@/lib/billing/enforce';
import { isAiPausedByServiceCap } from '@/lib/billing/service-cap';
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
 *   - the conversation is closed (an automation or an agent just
 *     resolved it)
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - the conversation's number spent its free service quota this
 *     month and the account chose `pause_ai` (p11.3; never blocks the
 *     inbound or a human's send, and fails open on a read error)
 *   - an automation already answered THIS inbound message
 *   - there's nothing to reply to
 *
 * One turn = one inbound message, and a turn sends AT MOST ONE outbound
 * message (p11.4: Meta bills per delivered message). The turn key is
 * `inbound_auto_replies.message_id` (migration 051), taken by
 * `claimInboundAutoReply` below; a retry of the same inbound loses it
 * and stays silent. Paragraphs go out in one message; a text over the
 * WhatsApp limit is truncated (`fitWhatsAppText`), never split; a send
 * that throws is not retried.
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 *
 * A reply that goes out bumps the account's `ai_replies` usage counter
 * once, via `recordUsage` (f3.4) — the same counter the quota gate above
 * reads.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args;

  try {
    const db = supabaseAdmin();

    const config = await loadAiConfig(db, accountId);
    if (!config || !config.autoReplyEnabled) return;

    // Fase 3 §4 + §5. Three separate gates, all of them SILENT: this
    // runs inside the webhook's `after()` block, so there is nobody to
    // return an error to. The inbound message is already stored (CP11 —
    // "lo entrante nunca se bloquea"); what stops here is the outbound
    // reply, and the thread simply waits for a human.
    //
    //   1. read-only account (suspended / expired / past grace),
    //   2. the plan does not include `ai_autoreply`,
    //   3. the monthly `ai_replies` allowance is spent.
    //
    // The allowance is charged whichever key paid the provider: with
    // the platform key (f0.4) the reply costs us money directly, and
    // with the tenant's own key it still consumes our pipeline — the
    // metric counts replies, not tokens, so `config.keySource` does not
    // enter into it.
    //
    // Deliberately BEFORE the per-message reservation below: a reply we
    // are not entitled to send must not consume the reservation, or the
    // inbound would be locked with nobody left to answer it.
    try {
      const entitlements = await assertWritable(accountId);
      await assertPlanFeature(accountId, 'ai_autoreply', entitlements);
      await assertQuota(accountId, 'ai_replies', 1);
    } catch (err) {
      console.warn(
        `[ai auto-reply] account ${accountId} is not entitled to an AI reply right now:`,
        err instanceof Error ? err.message : err
      );
      return;
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select(
        'status, assigned_agent_id, ai_autoreply_disabled, ai_reply_count, whatsapp_config_id'
      )
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convErr || !conv) return;
    // A closed thread is a finished thread. The customer writing again
    // re-opens it before we get here (`reopenClosedConversation`, issue
    // #409), so reading 'closed' at this point means something closed it
    // *after* this message landed — in practice a `close_conversation`
    // automation step that ran a few lines up in the webhook's `after()`
    // block, e.g. the keyword automation for "stop" / "unsubscribe".
    // That step sends nothing, so it takes no reservation and the
    // per-message guard would happily let the bot answer a customer who
    // just asked to be left alone. It is also what f1.3 decided for the
    // "unattended" queue: closed chats are the archive, not work.
    if (conv.status === 'closed') return;
    if (conv.assigned_agent_id) return; // a human owns this thread
    if (conv.ai_autoreply_disabled) return; // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return;

    // p11.3. Meta gives 1,000 delivered service messages per number and
    // month; past that it bills each one. An account on `pause_ai` asked
    // the bot to stop answering from a spent number until the 1st of next
    // month (UTC) — the pause lifts on its own, so `ai_autoreply_disabled`
    // is NOT touched and no handoff notice goes out. Humans keep writing
    // from the inbox; only this automatic reply stops (CP11).
    //
    // Before the reservation for the same reason as the billing gates
    // above: a reply we will not send must not lock the inbound, so an
    // automation can still answer it. Fails open: a read error returns
    // false inside `isAiPausedByServiceCap` and the AI replies as usual.
    if (
      await isAiPausedByServiceCap(db, {
        accountId,
        conversationId,
        sealedConfigId:
          (conv.whatsapp_config_id as string | null | undefined) ?? null,
      })
    ) {
      console.info(
        `[ai auto-reply] account ${accountId}: the free service quota of number ${conv.whatsapp_config_id ?? '(default)'} is spent and the account chose pause_ai — not replying.`
      );
      return;
    }

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

    // Record token spend, tagged with whose key paid for it (the
    // account's or the platform's). Fire-and-forget so it
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
      keySource: config.keySource,
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
            text: fitForOneMessage(handoffMessage, conversationId),
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

    // p11.4. Exactly one send for the reply: paragraphs stay in one
    // message, and an over-long text is truncated rather than rejected
    // whole by Meta (which used to lose the reply AND the slot above).
    // No retry if it throws: «sent to Meta but DB insert failed» means
    // the customer already has it.
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: fitForOneMessage(text, conversationId),
      aiGenerated: true,
    });

    // ONE counting of `ai_replies`, after the send succeeded.
    //
    // f1.5 (a private `countAiReply` calling `increment_usage`) and f3.4
    // (`recordUsage`) each added their own bump here; keeping both would
    // have charged every reply twice. `recordUsage` is the survivor: it
    // is the same RPC with the same fail-safe semantics (it swallows
    // both the `{ error }` supabase-js resolves with and an outright
    // throw), it is the counter the other seven enforcement points of
    // f3.4 already use, and it is the counter `assertQuota` reads above —
    // so what blocks a reply is exactly what counts one.
    //
    // After `engineSendText`, never before: it throws when Meta rejects
    // the send, so a reply the customer never got is never billed. The
    // handoff/transition notice of f1.2 returns well above this point —
    // it is an acknowledgement, not a reply, and does not count.
    // `messages_out` is charged separately, inside `engineSendText`: an
    // AI reply is also an outbound message.
    await recordUsage(accountId, 'ai_replies', 1);
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err);
  }
}

/**
 * Fit an outbound text into one WhatsApp message (p11.4, R3). Logs the
 * truncation with the conversation id and the original length — never the
 * text, which may carry customer data.
 */
function fitForOneMessage(text: string, conversationId: string): string {
  const fitted = fitWhatsAppText(text);
  if (fitted.truncated) {
    console.warn('[ai auto-reply] reply truncated to the WhatsApp limit', {
      conversationId,
      originalLength: fitted.originalLength,
    });
  }
  return fitted.text;
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
