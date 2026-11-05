import { beforeEach, describe, expect, it, vi } from 'vitest';

// n13.3 (R5, R28, R37, R38): el bot carga las herramientas con la cuenta del
// webhook y las pasa a generateReply solo si hay alguna; el uso que se
// registra es el sumado del turno.

const h = vi.hoisted(() => ({
  loadAiToolset: vi.fn(),
  generateReply: vi.fn(),
  logAiUsage: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  engineSendText: vi.fn(async () => {}),
  entitlements: {
    planId: 'pro',
    status: 'active',
    limits: {},
    features: ['ai_autoreply', 'integrations'],
    readOnly: false,
    trialEndsAt: null,
  },
  db: null as unknown,
}));

vi.mock('./tools/load', () => ({ loadAiToolset: h.loadAiToolset }));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('./usage', () => ({ logAiUsage: h.logAiUsage }));
vi.mock('./config', () => ({
  loadAiConfig: vi.fn(async () => ({
    provider: 'anthropic',
    model: 'm',
    apiKey: 'k',
    keySource: 'account',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffMode: 'queue',
    handoffAgentId: null,
    handoffMessage: null,
    embeddingsApiKey: null,
    embeddingsProvider: 'openai',
  })),
}));
vi.mock('./context', () => ({
  buildConversationContext: vi.fn(async () => [
    { role: 'user', content: '¿Hay cita mañana?' },
  ]),
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: vi.fn(async () => []) }));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }));
vi.mock('@/lib/automations/reply-marker', () => ({
  claimInboundAutoReply: vi.fn(async () => true),
}));
vi.mock('@/lib/billing/service-cap', () => ({
  isAiPausedByServiceCap: vi.fn(async () => false),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  RATE_LIMITS: { aiAutoReplyAccount: {} },
}));
vi.mock('@/lib/billing/enforce', () => ({
  assertWritable: vi.fn(async () => h.entitlements),
  assertPlanFeature: vi.fn(async () => h.entitlements),
  assertQuota: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.db }));

import { dispatchInboundToAiReply } from './auto-reply';
import { AiError } from './types';

const ACCOUNT = 'acct-A';
const toolset = {
  tools: [
    {
      name: 'health__search',
      integrationSlug: 'health',
      integrationName: 'Health',
      operationKey: 'search',
      method: 'GET',
      description: 'Search',
      parameters: { type: 'object', properties: {} },
      declaredParams: [],
    },
  ],
  integrations: [
    { slug: 'health', name: 'Health', instructions: null, timezone: null },
  ],
};
const usage = { promptTokens: 30, completionTokens: 3, totalTokens: 33 };

function fakeDb() {
  return {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = () => q;
      q.maybeSingle = async () => ({
        data: {
          status: 'open',
          assigned_agent_id: null,
          ai_autoreply_disabled: false,
          ai_reply_count: 0,
          whatsapp_config_id: null,
        },
        error: null,
      });
      return q;
    },
    rpc: async () => ({ data: true, error: null }),
  };
}

const dispatch = () =>
  dispatchInboundToAiReply({
    accountId: ACCOUNT,
    conversationId: 'conv-1',
    contactId: 'contact-1',
    inboundMessageId: 'msg-1',
    configOwnerUserId: 'owner-1',
  });

beforeEach(() => {
  h.db = fakeDb();
  h.generateReply.mockResolvedValue({
    text: 'Sí, a las 10:00.',
    handoff: false,
    usage,
    toolsUsed: [{ integration: 'Health', operation: 'search', ok: true }],
  });
});

describe('auto-reply with integration tools', () => {
  it('loads tools for the webhook account with its entitlements and passes them on', async () => {
    h.loadAiToolset.mockResolvedValue(toolset);
    await dispatch();
    expect(h.loadAiToolset).toHaveBeenCalledWith(h.db, ACCOUNT, {
      mode: 'auto_reply',
      entitlements: h.entitlements,
    });
    const call = h.generateReply.mock.calls[0][0];
    expect(call.tools).toEqual({ toolset, db: h.db, accountId: ACCOUNT });
    expect(call.systemPrompt).toContain('Tools: you can call tools');
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
  });

  it('logs ONE ai_usage_log row with the summed usage (R37)', async () => {
    h.loadAiToolset.mockResolvedValue(toolset);
    await dispatch();
    expect(h.logAiUsage).toHaveBeenCalledTimes(1);
    expect(h.logAiUsage.mock.calls[0][1]).toMatchObject({
      accountId: ACCOUNT,
      mode: 'auto_reply',
      usage,
    });
  });

  it('without tools generateReply gets exactly {config, systemPrompt, messages}', async () => {
    h.loadAiToolset.mockResolvedValue({ tools: [], integrations: [] });
    await dispatch();
    const call = h.generateReply.mock.calls[0][0];
    expect(Object.keys(call).sort()).toEqual([
      'config',
      'messages',
      'systemPrompt',
    ]);
    expect(call.systemPrompt).not.toContain('Tools: you can call tools');
  });

  it('a failed later tool round still logs the usage of the earlier rounds (finding 6)', async () => {
    h.loadAiToolset.mockResolvedValue(toolset);
    const err = new AiError('down', { code: 'timeout' });
    err.usage = usage;
    h.generateReply.mockRejectedValue(err);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await dispatch();
    expect(h.logAiUsage).toHaveBeenCalledTimes(1);
    expect(h.logAiUsage.mock.calls[0][1]).toMatchObject({
      accountId: ACCOUNT,
      conversationId: 'conv-1',
      mode: 'auto_reply',
      usage,
    });
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('a failure without earlier usage logs nothing', async () => {
    h.loadAiToolset.mockResolvedValue(toolset);
    h.generateReply.mockRejectedValue(new AiError('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await dispatch();
    expect(h.logAiUsage).not.toHaveBeenCalled();
  });
});
