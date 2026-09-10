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
    autoResponders: [] as { id: string }[],
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
    conversationUpdateFilters: [] as [string, unknown][],
    rpcCalls: [] as { name: string; args: unknown }[],
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
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        };
        return chain;
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
        select: () => selectChain,
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
      return Promise.resolve({ data: h.state.claim, error: null });
    },
  }),
}));

import { dispatchInboundToAiReply } from './auto-reply';

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
};

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
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
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  };
  h.state.autoResponders = [];
  h.state.claim = true;
  h.state.pick = null;
  h.state.updatePayload = null;
  h.state.updateError = null;
  h.state.updateAttempts = 0;
  h.state.updatesApplied = 0;
  h.state.conversationSelectFilters = [];
  h.state.conversationUpdateFilters = [];
  h.state.rpcCalls = [];
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

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }];
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
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
    await Promise.all([
      dispatchInboundToAiReply(ARGS),
      dispatchInboundToAiReply(ARGS),
    ]);
    // Both dispatches read `ai_autoreply_disabled = false` and both try
    // to write; the conditional UPDATE lets exactly one through, and only
    // the winner texts the customer.
    expect(h.state.updateAttempts).toBe(2);
    expect(h.state.updatesApplied).toBe(1);
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
  });
});
