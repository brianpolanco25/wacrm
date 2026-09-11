import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AccountLockedError,
  FeatureNotAvailableError,
  QuotaExceededError,
} from '@/lib/billing/enforce'
import type { AiConfig } from './types'

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
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

// Fase 3 §4/§5: the entitlement gates. Only the DB-touching entry
// points are stubbed — `importOriginal` keeps the error classes real —
// so a test can drive each gate independently and still assert against
// the genuine `AccountLockedError` / `FeatureNotAvailableError` /
// `QuotaExceededError`.
const billing = vi.hoisted(() => {
  const entitlements = {
    planId: 'pro',
    status: 'active' as const,
    limits: {} as Record<string, number | null>,
    features: ['ai_autoreply'],
    readOnly: false,
    trialEndsAt: null,
  }
  return {
    entitlements,
    assertWritable: vi.fn(async () => entitlements),
    assertPlanFeature: vi.fn(async () => entitlements),
    assertQuota: vi.fn(async () => {}),
    recordUsage: vi.fn(async () => {}),
  }
})
vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertWritable: billing.assertWritable,
  assertPlanFeature: billing.assertPlanFeature,
  assertQuota: billing.assertQuota,
  recordUsage: billing.recordUsage,
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
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
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

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
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  for (const fn of [
    billing.assertWritable,
    billing.assertPlanFeature,
    billing.assertQuota,
    billing.recordUsage,
  ]) {
    fn.mockClear()
  }
  billing.assertWritable.mockResolvedValue(billing.entitlements)
  billing.assertPlanFeature.mockResolvedValue(billing.entitlements)
  billing.assertQuota.mockResolvedValue(undefined)
  billing.recordUsage.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

// ---------------------------------------------------------------------------
// Fase 3 §4 — `ai_replies` + the `ai_autoreply` feature, and §5's
// read-only ladder. All three gates are SILENT: this runs inside the
// webhook's `after()`, where there is nobody to answer with an error.
// The inbound message is already stored; only the outbound reply stops.
// ---------------------------------------------------------------------------
describe('dispatchInboundToAiReply — plan entitlements (fase 3 §4/§5)', () => {
  it('does not reply while the account is read-only', async () => {
    billing.assertWritable.mockRejectedValue(
      new AccountLockedError('suspended')
    );
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(billing.recordUsage).not.toHaveBeenCalled();
  });

  it('does not reply when the plan has no ai_autoreply', async () => {
    billing.assertPlanFeature.mockRejectedValue(
      new FeatureNotAvailableError('ai_autoreply')
    );
    await dispatchInboundToAiReply(ARGS);
    expect(billing.assertPlanFeature).toHaveBeenCalledWith(
      'acct-1',
      'ai_autoreply',
      billing.entitlements
    );
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('does not reply once the monthly ai_replies allowance is spent', async () => {
    billing.assertQuota.mockRejectedValue(
      new QuotaExceededError('ai_replies', 3000, 3000)
    );
    await dispatchInboundToAiReply(ARGS);
    expect(billing.assertQuota).toHaveBeenCalledWith('acct-1', 'ai_replies', 1);
    // The provider is never called either: an allowance check that let
    // the tokens be spent anyway would protect nothing.
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('gates the account of the inbound, not some other one', async () => {
    await dispatchInboundToAiReply({ ...ARGS, accountId: 'acct-other' });
    expect(billing.assertWritable).toHaveBeenCalledWith('acct-other');
    expect(billing.assertQuota).toHaveBeenCalledWith(
      'acct-other',
      'ai_replies',
      1
    );
    expect(billing.recordUsage).toHaveBeenCalledWith(
      'acct-other',
      'ai_replies',
      1
    );
  });

  it('counts one ai_reply after the send, and only after', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).toHaveBeenCalled();
    expect(billing.recordUsage).toHaveBeenCalledWith('acct-1', 'ai_replies', 1);
    expect(billing.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('counts a reply paid for with the PLATFORM key exactly the same', async () => {
    // f0.4 — `keySource` decides whose key paid the provider. The
    // metric counts replies, not tokens, so both sources are billable.
    h.loadAiConfig.mockResolvedValue(aiConfig({ keySource: 'platform' }));
    await dispatchInboundToAiReply(ARGS);
    expect(billing.recordUsage).toHaveBeenCalledWith('acct-1', 'ai_replies', 1);
  });

  it('does not count the handoff transition — it is not a reply', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(billing.recordUsage).not.toHaveBeenCalled();
  });

  it('does not count when the per-conversation slot claim loses the race', async () => {
    h.state.claim = false;
    await dispatchInboundToAiReply(ARGS);
    expect(billing.recordUsage).not.toHaveBeenCalled();
  });

  it('does not count when the send itself throws', async () => {
    h.engineSendText.mockRejectedValue(new Error('Meta refused'));
    await dispatchInboundToAiReply(ARGS);
    expect(billing.recordUsage).not.toHaveBeenCalled();
  });
});
