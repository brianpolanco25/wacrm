import { beforeEach, describe, expect, it, vi } from 'vitest';

// n13.7 (R9, R10, R16, R27): el bot carga las lecturas en vivo SOLO tras
// ganar la reserva y pasar el límite por cuenta; su bloque llega al system
// prompt y la conversación llega al bucle.

const h = vi.hoisted(() => ({
  loadAiToolset: vi.fn(),
  loadLiveData: vi.fn(),
  generateReply: vi.fn(),
  claim: vi.fn(async () => true),
  rateOk: { value: true },
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
vi.mock('./tools/live', () => ({ loadLiveData: h.loadLiveData }));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('./usage', () => ({ logAiUsage: vi.fn(async () => {}) }));
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
    { role: 'user', content: '¿Qué días tienen libres?' },
  ]),
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: vi.fn(async () => []) }));
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: vi.fn(async () => {}),
}));
vi.mock('@/lib/automations/reply-marker', () => ({
  claimInboundAutoReply: h.claim,
}));
vi.mock('@/lib/billing/service-cap', () => ({
  isAiPausedByServiceCap: vi.fn(async () => false),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: h.rateOk.value }),
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

const ACCOUNT = 'acct-A';
const toolset = {
  tools: [
    {
      name: 'cabbity_health__find_availability',
      integrationSlug: 'cabbity-health',
      integrationName: 'Cabbity Health',
      operationKey: 'find_availability',
      method: 'GET',
      description: 'Find',
      parameters: { type: 'object', properties: {} },
      declaredParams: [],
      policy: { grounds: ['schedule'] },
    },
  ],
  integrations: [
    {
      slug: 'cabbity-health',
      name: 'Cabbity Health',
      instructions: null,
      timezone: null,
      liveReads: [{ operation: 'find_availability', params: {} }],
    },
  ],
};
const liveBlock = {
  integrationSlug: 'cabbity-health',
  integrationName: 'Cabbity Health',
  operationKey: 'find_availability',
  timeZone: null,
  loadedAt: new Date('2026-11-10T14:00:00Z'),
  result: { ok: true, data: { data: [] } },
  grounds: ['schedule'],
};

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
  h.rateOk.value = true;
  h.claim.mockResolvedValue(true);
  h.loadAiToolset.mockResolvedValue(toolset);
  h.loadLiveData.mockResolvedValue([liveBlock]);
  h.generateReply.mockResolvedValue({
    text: 'No hay huecos esta semana.',
    handoff: false,
    usage: null,
    toolsUsed: [],
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('auto-reply live data (n13.7)', () => {
  it('R10: a lost claim → no live reads', async () => {
    h.claim.mockResolvedValue(false);
    await dispatch();
    expect(h.loadLiveData).not.toHaveBeenCalled();
    expect(h.generateReply).not.toHaveBeenCalled();
  });

  it('R10: over the per-account limit → no live reads', async () => {
    h.rateOk.value = false;
    await dispatch();
    expect(h.loadLiveData).not.toHaveBeenCalled();
  });

  it('R9/R16/R27: after the claim the block goes into the prompt and the conversation into the loop', async () => {
    await dispatch();
    expect(h.loadLiveData).toHaveBeenCalledTimes(1);
    expect(h.loadLiveData.mock.calls[0][0]).toBe(h.db);
    expect(h.loadLiveData.mock.calls[0][1]).toMatchObject({
      accountId: ACCOUNT,
      toolset,
      conversationId: 'conv-1',
    });
    const call = h.generateReply.mock.calls[0][0];
    expect(call.systemPrompt).toContain('Live data:');
    expect(call.systemPrompt).toContain('Cabbity Health · find_availability');
    expect(call.tools).toEqual({ toolset, db: h.db, accountId: ACCOUNT });
    expect(call.grounding).toEqual({
      mode: 'auto_reply',
      liveData: [liveBlock],
      conversationId: 'conv-1',
    });
  });

  it('without tools → no live reads and the plain call', async () => {
    h.loadAiToolset.mockResolvedValue({ tools: [], integrations: [] });
    await dispatch();
    expect(h.loadLiveData).not.toHaveBeenCalled();
    expect(Object.keys(h.generateReply.mock.calls[0][0]).sort()).toEqual([
      'config',
      'messages',
      'systemPrompt',
    ]);
  });
});
