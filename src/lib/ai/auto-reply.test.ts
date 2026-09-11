import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiConfig } from './types';

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    /** `inbound_auto_replies` (migration 051), keyed the way Postgres
     *  keys it: by message id alone. Pre-seed an entry to stand for "an
     *  automation already answered this inbound". */
    autoReplyClaims: new Map<string, Record<string, unknown>>(),
    /** Error the reservation upsert resolves with. */
    claimWriteError: null as { message: string } | null,
    claimUpserts: [] as Record<string, unknown>[],
    /** Tables the dispatch touched, to prove the account-wide automation
     *  lookup is gone for good. */
    tablesRead: [] as string[],
    claim: true as boolean,
    /** What `pick_available_agent` returns (null = nobody online). */
    pick: null as string | null,
    updatePayload: null as Record<string, unknown> | null,
    /** Error the conditional handoff UPDATE resolves with (supabase-js
     *  resolves `{ error }` instead of throwing). */
    updateError: null as { message: string } | null,
    /** How many UPDATEs were issued vs. how many matched a row — the
     *  difference is what the `ai_autoreply_disabled = false` predicate
     *  filters out. */
    updateAttempts: 0,
    updatesApplied: 0,
    conversationSelectFilters: [] as [string, unknown][],
    /** Columns the conversation read asked for, so a gate can't be
     *  quietly disarmed by dropping its column from the SELECT. */
    conversationSelectColumns: '' as string,
    conversationUpdateFilters: [] as [string, unknown][],
    rpcCalls: [] as { name: string; args: unknown }[],
    /** Error `increment_usage` resolves with (supabase-js style). */
    usageError: null as { message: string } | null,
    /** Make `increment_usage` throw instead of resolving, to prove the
     *  counter can never take down a reply that already went out. */
    usageThrows: false,
    /** `usage_counters.value` after the increment, per account+metric —
     *  the RPC returns the new total. */
    usage: new Map<string, number>(),
  },
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      h.state.tablesRead.push(table);
      if (table === 'inbound_auto_replies') {
        // `.upsert(payload, { onConflict: 'message_id', ignoreDuplicates
        //  : true }).select()` — the row comes back only on a genuine
        // insert, which is how Postgres reports who won the reservation.
        return {
          upsert: (payload: Record<string, unknown>) => ({
            select: () => {
              h.state.claimUpserts.push(payload);
              if (h.state.claimWriteError) {
                return Promise.resolve({
                  data: null,
                  error: h.state.claimWriteError,
                });
              }
              const key = payload.message_id as string;
              if (h.state.autoReplyClaims.has(key)) {
                return Promise.resolve({ data: [], error: null });
              }
              h.state.autoReplyClaims.set(key, payload);
              return Promise.resolve({
                data: [{ message_id: key }],
                error: null,
              });
            },
          }),
        };
      }
      // conversations
      const selectChain = {
        eq: (column: string, value: unknown) => {
          h.state.conversationSelectFilters.push([column, value]);
          return selectChain;
        },
        maybeSingle: () => Promise.resolve({ data: h.state.conv, error: null }),
      };
      // `update(...).eq(...).select('id')` — PostgREST returns the rows
      // the UPDATE actually matched. Modelled faithfully (including the
      // conditional `ai_autoreply_disabled = false` predicate against the
      // shared conversation row) so two concurrent dispatches race here
      // the way they would in Postgres.
      const updateChain = (payload: Record<string, unknown>) => {
        const filters: [string, unknown][] = [];
        const chain = {
          eq: (column: string, value: unknown) => {
            h.state.conversationUpdateFilters.push([column, value]);
            filters.push([column, value]);
            return chain;
          },
          select: () => {
            if (h.state.updateError) {
              return Promise.resolve({
                data: null,
                error: h.state.updateError,
              });
            }
            const guarded = filters.some(
              ([column, value]) =>
                column === 'ai_autoreply_disabled' && value === false
            );
            if (guarded && h.state.conv?.ai_autoreply_disabled) {
              return Promise.resolve({ data: [], error: null }); // lost the race
            }
            h.state.updatePayload = payload;
            h.state.updatesApplied += 1;
            if (h.state.conv) h.state.conv = { ...h.state.conv, ...payload };
            return Promise.resolve({ data: [{ id: 'conv-1' }], error: null });
          },
        };
        return chain;
      };
      return {
        select: (columns: string) => {
          h.state.conversationSelectColumns = columns;
          return selectChain;
        },
        update: (payload: Record<string, unknown>) => {
          h.state.updateAttempts += 1;
          return updateChain(payload);
        },
      };
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args });
      if (name === 'pick_available_agent') {
        return Promise.resolve({ data: h.state.pick, error: null });
      }
      if (name === 'increment_usage') {
        // Migration 041: upsert keyed by (account_id, metric, period)
        // that returns the new total. Modelled per account so a leak
        // between tenants shows up as a count on the wrong key.
        if (h.state.usageThrows) throw new Error('network down');
        if (h.state.usageError) {
          return Promise.resolve({ data: null, error: h.state.usageError });
        }
        const a = args as {
          p_account_id: string;
          p_metric: string;
          p_delta: number;
        };
        const key = `${a.p_account_id}:${a.p_metric}`;
        const next = (h.state.usage.get(key) ?? 0) + a.p_delta;
        h.state.usage.set(key, next);
        return Promise.resolve({ data: next, error: null });
      }
      return Promise.resolve({ data: h.state.claim, error: null });
    },
  }),
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { dispatchInboundToAiReply } from './auto-reply';

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  inboundMessageId: 'msg-1',
  configOwnerUserId: 'user-1',
};

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    keySource: 'account',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffMode: 'queue',
    handoffAgentId: null,
    handoffMessage: null,
    embeddingsApiKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  // The per-account auto-reply throttle (30/min) lives in a module-level
  // map: without this reset the Nth test in the file starts hitting it
  // and the dispatch silently stops sending, which reads as an unrelated
  // failure. Reset it so each test starts from a clean window.
  __resetRateLimitForTests();
  h.state.conv = {
    status: 'open',
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  };
  h.state.autoReplyClaims = new Map();
  h.state.claimWriteError = null;
  h.state.claimUpserts = [];
  h.state.tablesRead = [];
  h.state.claim = true;
  h.state.pick = null;
  h.state.updatePayload = null;
  h.state.updateError = null;
  h.state.updateAttempts = 0;
  h.state.updatesApplied = 0;
  h.state.conversationSelectFilters = [];
  h.state.conversationSelectColumns = '';
  h.state.conversationUpdateFilters = [];
  h.state.rpcCalls = [];
  h.state.usageError = null;
  h.state.usageThrows = false;
  h.state.usage = new Map();
  h.loadAiConfig.mockResolvedValue(aiConfig());
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: 'hi' },
  ]);
  h.retrieveKnowledge.mockResolvedValue([]);
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false });
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' });
});

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
      {
        name: 'increment_usage',
        args: {
          p_account_id: 'acct-1',
          p_metric: 'ai_replies',
          p_delta: 1,
        },
      },
    ]);
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' })
    );
  });

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.']);
    await dispatchInboundToAiReply(ARGS);
    expect(h.retrieveKnowledge).toHaveBeenCalled();
    const systemPrompt = h.generateReply.mock.calls[0][0]
      .systemPrompt as string;
    expect(systemPrompt).toContain('Returns accepted within 30 days.');
  });

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false;
    await dispatchInboundToAiReply(ARGS);
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('stays quiet in a conversation an automation just closed', async () => {
    // A customer writing again re-opens the thread before the dispatch
    // runs (issue #409), so 'closed' here means something closed it after
    // this inbound landed — in practice a `close_conversation` step on a
    // "stop"/"unsubscribe" keyword, which sends nothing and therefore
    // takes no reservation. Without this gate the per-message guard let
    // the bot answer the customer who just asked to be left alone.
    h.state.conv = {
      status: 'closed',
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
    // Bailed before the reservation, so the message stays free — nothing
    // else was going to answer it anyway.
    expect(h.state.claimUpserts).toEqual([]);
  });

  it('still replies in an open or pending thread', async () => {
    h.state.conv = { ...h.state.conv!, status: 'pending' };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).toHaveBeenCalled();
  });

  it('reads the status column it gates on', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.conversationSelectColumns).toContain('status');
  });

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([]);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });
});

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send a reply on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    // No handoff message configured → nothing goes out, no slot claimed.
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off'
    );
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id');
  });

  it('fixed mode routes to the configured handoff agent', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ handoffMode: 'fixed', handoffAgentId: 'agent-7' })
    );
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    });
    // No presence lookup in fixed mode.
    expect(h.state.rpcCalls.map((c) => c.name)).not.toContain(
      'pick_available_agent'
    );
  });

  it('queue mode leaves the thread unassigned even if a stale agent is stored', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ handoffMode: 'queue', handoffAgentId: 'agent-7' })
    );
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id');
    expect(h.state.rpcCalls).toHaveLength(0);
  });

  it('auto mode assigns to the agent pick_available_agent returns, scoped to the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffMode: 'auto' }));
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    h.state.pick = 'agent-least-loaded';
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls).toEqual([
      { name: 'pick_available_agent', args: { p_account_id: 'acct-1' } },
    ]);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-least-loaded',
    });
  });

  it('auto mode with nobody online (NULL) behaves like queue and does not throw', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffMode: 'auto' }));
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    h.state.pick = null;
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls.map((c) => c.name)).toEqual([
      'pick_available_agent',
    ]);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id');
  });

  it('never stomps an existing human assignment (auto mode, thread already owned)', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffMode: 'auto' }));
    h.state.pick = 'agent-least-loaded';
    h.state.conv = {
      assigned_agent_id: 'human-owner',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    // A human owns the thread: the bot stands down entirely — no model
    // call, no pick, no write.
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.state.updatePayload).toBeNull();
  });

  it('scopes the service-role conversation read and handoff write to its account', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ handoffMode: 'fixed', handoffAgentId: 'agent-7' })
    );
    h.generateReply.mockResolvedValue({ text: '', handoff: true });

    await dispatchInboundToAiReply(ARGS);

    expect(h.state.conversationSelectFilters).toEqual([
      ['id', 'conv-1'],
      ['account_id', 'acct-1'],
    ]);
    expect(h.state.conversationUpdateFilters).toEqual([
      ['id', 'conv-1'],
      ['account_id', 'acct-1'],
      // Concurrency guard, not tenancy — but it must not replace the
      // account filter.
      ['ai_autoreply_disabled', false],
    ]);
  });
});

describe('dispatchInboundToAiReply — handoff transition message (fase 1)', () => {
  const MSG =
    'Gracias por escribirnos. Un miembro de nuestro equipo continuará.';

  beforeEach(() => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
  });

  it('sends exactly one transition message, marked as AI-generated', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffMessage: MSG }));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(h.engineSendText).toHaveBeenCalledWith({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: MSG,
      aiGenerated: true,
    });
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
  });

  it('does not claim a reply slot nor count as an AI reply', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffMessage: MSG }));
    await dispatchInboundToAiReply(ARGS);
    const names = h.state.rpcCalls.map((c) => c.name);
    expect(names).not.toContain('claim_ai_reply_slot');
    expect(names).not.toContain('increment_usage');
  });

  it('sends nothing when the message is empty or whitespace, and still hands off', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffMessage: '   ' }));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
  });

  it('leaves the conversation handed off and assigned when the send fails', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({
        handoffMessage: MSG,
        handoffMode: 'fixed',
        handoffAgentId: 'agent-7',
      })
    );
    h.engineSendText.mockRejectedValue(new Error('Meta 500'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    });
  });

  it('sends nothing when the handoff write fails (it would be re-sent on every inbound)', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffMessage: MSG }));
    h.state.updateError = { message: 'permission denied for conversations' };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let logged: unknown[][] = [];
    try {
      await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined();
      logged = errorSpy.mock.calls; // mockRestore() wipes them
    } finally {
      errorSpy.mockRestore();
    }
    expect(h.state.updateAttempts).toBe(1);
    expect(h.engineSendText).not.toHaveBeenCalled();
    // A lost UPDATE must be loud: it is what makes "the bot keeps
    // re-announcing the handoff" diagnosable.
    expect(logged.flat().join(' ')).toContain('handoff write failed');
  });

  it('sends exactly one notice when two inbounds hand off concurrently', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffMessage: MSG }));
    // Two DIFFERENT customer messages a second apart, so each takes its
    // own per-message reservation (fase 1 §4) and both really do reach
    // the handoff write — which is the race this test is about.
    await Promise.all([
      dispatchInboundToAiReply({ ...ARGS, inboundMessageId: 'msg-1' }),
      dispatchInboundToAiReply({ ...ARGS, inboundMessageId: 'msg-2' }),
    ]);
    // Both dispatches read `ai_autoreply_disabled = false` and both try
    // to write; the conditional UPDATE lets exactly one through, and only
    // the winner texts the customer.
    expect(h.state.updateAttempts).toBe(2);
    expect(h.state.updatesApplied).toBe(1);
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
  });
});

/**
 * Fase 1, §4 — the guard is per message, not per account.
 *
 * What it replaced: "the account has ONE active `keyword_match` or
 * `new_message_received` automation → the bot is mute in every chat of
 * the company". One automation answering "opening hours" used to turn
 * the whole AI agent off, silently.
 */
describe('dispatchInboundToAiReply — per-message automation guard (fase 1)', () => {
  it('replies when no automation answered this message, even with active ones in the account', async () => {
    // Criterion 1. The account may be full of active keyword
    // automations; none of them answered THIS inbound, so the marker
    // table is empty and the bot talks. The old guard failed this by
    // construction — it never looked at the message.
    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' })
    );
    // And it is no longer decided by an account-wide census of
    // automations: that query is gone.
    expect(h.state.tablesRead).not.toContain('automations');
  });

  it('stays quiet when an automation already answered this message', async () => {
    // Criterion 2. The engine reserved the reply for msg-1 just before
    // sending, inside the same `after()` block, so our reservation loses.
    h.state.autoReplyClaims.set('msg-1', {
      message_id: 'msg-1',
      account_id: 'acct-1',
      responder: 'automation',
      automation_id: 'auto-9',
    });

    await dispatchInboundToAiReply(ARGS);

    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toHaveLength(0);
  });

  it('still replies to the NEXT message the automation did not answer', async () => {
    h.state.autoReplyClaims.set('msg-1', { responder: 'automation' });

    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();

    await dispatchInboundToAiReply({ ...ARGS, inboundMessageId: 'msg-2' });
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
  });

  it('sends exactly one automatic reply when the same inbound is dispatched twice', async () => {
    // Criterion 3. Two dispatches of the same message (a Meta redelivery
    // racing the first one) both pass the cheap gates; the primary key on
    // `inbound_auto_replies.message_id` lets exactly one through.
    await Promise.all([
      dispatchInboundToAiReply(ARGS),
      dispatchInboundToAiReply(ARGS),
    ]);

    expect(h.state.claimUpserts).toHaveLength(2);
    expect(h.state.autoReplyClaims.size).toBe(1);
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
  });

  it('does not send the handoff notice either when it lost the reservation', async () => {
    // The transition message is a second automatic message about the same
    // inbound, so losing the reservation has to silence it too.
    h.state.autoReplyClaims.set('msg-1', { responder: 'automation' });
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffMessage: 'A human…' }));
    h.generateReply.mockResolvedValue({ text: '', handoff: true });

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.updateAttempts).toBe(0);
  });

  it('tags the reservation with the dispatch account (it is service-role, RLS does not apply)', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.claimUpserts).toEqual([
      {
        message_id: 'msg-1',
        account_id: 'acct-1',
        responder: 'ai',
        automation_id: null,
      },
    ]);
  });

  it('reserves nothing for a thread a human already owns', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.claimUpserts).toEqual([]);
  });

  it('fails closed when the reservation cannot be written', async () => {
    h.state.claimWriteError = { message: 'relation does not exist' };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await dispatchInboundToAiReply(ARGS);
    } finally {
      errorSpy.mockRestore();
    }
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });
});

/**
 * Fase 1, f1.5 — the `ai_replies` usage counter (migration 041).
 *
 * Fase 0 §4 decided the metric starts counting in fase 1 even though no
 * limit is applied until fase 3, so the closed beta produces real
 * numbers to set the quotas with. Three things to prove: it counts a
 * delivered reply (and only after it is delivered), the f1.2 transition
 * message does not count, and nothing here refuses to send.
 */
describe('dispatchInboundToAiReply — ai_replies counter (f1.5)', () => {
  function usageCalls() {
    return h.state.rpcCalls.filter((c) => c.name === 'increment_usage');
  }

  it('counts one ai_reply for the account after a delivered reply', async () => {
    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(usageCalls()).toEqual([
      {
        name: 'increment_usage',
        args: { p_account_id: 'acct-1', p_metric: 'ai_replies', p_delta: 1 },
      },
    ]);
    expect(h.state.usage.get('acct-1:ai_replies')).toBe(1);
  });

  it('counts AFTER the send, never before it', async () => {
    // Criterion 1 is about order, not just about the call existing:
    // counting first would bill a reply Meta then refused.
    let rpcNamesWhenSending: string[] = [];
    h.engineSendText.mockImplementation(async () => {
      rpcNamesWhenSending = h.state.rpcCalls.map((c) => c.name);
      return { whatsapp_message_id: 'm1' };
    });

    await dispatchInboundToAiReply(ARGS);

    expect(rpcNamesWhenSending).not.toContain('increment_usage');
    expect(h.state.rpcCalls.map((c) => c.name)).toEqual([
      'claim_ai_reply_slot',
      'increment_usage',
    ]);
  });

  it('does not count a reply the send rejected', async () => {
    h.engineSendText.mockRejectedValue(new Error('Meta 500'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
    expect(usageCalls()).toEqual([]);
    expect(h.state.usage.size).toBe(0);
  });

  it('does not count when the dispatch never sends (slot race lost)', async () => {
    h.state.claim = false;
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(usageCalls()).toEqual([]);
  });

  it('does not count when an automation already answered this inbound', async () => {
    h.state.autoReplyClaims.set('msg-1', { responder: 'automation' });
    await dispatchInboundToAiReply(ARGS);
    expect(usageCalls()).toEqual([]);
  });

  it('does not count the handoff transition message (f1.2)', async () => {
    // Criterion 2. The notice is an acknowledgement, not a reply: it
    // goes out, and the counter stays where it was.
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ handoffMessage: 'A human will take over.' })
    );
    h.generateReply.mockResolvedValue({ text: '', handoff: true });

    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(usageCalls()).toEqual([]);
    expect(h.state.usage.size).toBe(0);
  });

  it('counts against the account of the dispatch, never another tenant', async () => {
    // Service role bypasses RLS, so the account only exists as the
    // argument we pass. Two tenants replying must land on two keys.
    await dispatchInboundToAiReply(ARGS);
    await dispatchInboundToAiReply({
      ...ARGS,
      accountId: 'acct-2',
      conversationId: 'conv-2',
      inboundMessageId: 'msg-2',
    });

    expect(usageCalls().map((c) => c.args)).toEqual([
      { p_account_id: 'acct-1', p_metric: 'ai_replies', p_delta: 1 },
      { p_account_id: 'acct-2', p_metric: 'ai_replies', p_delta: 1 },
    ]);
    expect(h.state.usage.get('acct-1:ai_replies')).toBe(1);
    expect(h.state.usage.get('acct-2:ai_replies')).toBe(1);
  });

  it('counts per account regardless of whose API key paid (keySource)', async () => {
    // f0.4: the platform key funding the call is cost attribution
    // (`ai_usage_log`); plan consumption is counted the same either way.
    h.loadAiConfig.mockResolvedValue(aiConfig({ keySource: 'platform' }));
    await dispatchInboundToAiReply(ARGS);
    expect(usageCalls()).toHaveLength(1);
    expect(h.state.usage.get('acct-1:ai_replies')).toBe(1);
  });

  it('logs and swallows a counter error — the reply was already delivered', async () => {
    h.state.usageError = { message: 'permission denied for function' };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let logged: unknown[][] = [];
    try {
      await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined();
      logged = errorSpy.mock.calls; // mockRestore() wipes them
    } finally {
      errorSpy.mockRestore();
    }
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(logged.flat().join(' ')).toContain('increment_usage(ai_replies)');
  });

  it('survives the counter throwing outright', async () => {
    h.state.usageThrows = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
  });

  it('applies no limit: it reads no plan, subscription or counter first', async () => {
    // Criterion 3. Enforcement is f3.4, on the fase 3 branch. Counting
    // must not become a gate by accident: a full counter still replies.
    h.state.usage.set('acct-1:ai_replies', 999_999);
    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(h.state.tablesRead).not.toContain('subscriptions');
    expect(h.state.tablesRead).not.toContain('plans');
    expect(h.state.tablesRead).not.toContain('usage_counters');
  });
});
