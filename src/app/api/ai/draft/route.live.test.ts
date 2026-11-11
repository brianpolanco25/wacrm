import { beforeEach, describe, expect, it, vi } from 'vitest';

// n13.7 R9, R16, R39: el borrador lleva las lecturas en vivo en el prompt
// y corre en modo `draft` (sin guardia del texto).

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  generateReply: vi.fn(),
  loadAiToolset: vi.fn(),
  loadLiveData: vi.fn(),
  admin: { tag: 'admin' },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'x' }, { status: 403 })),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { aiDraft: {}, aiDraftAccount: {} },
}));
vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: vi.fn(async () => ({
    provider: 'openai',
    model: 'o',
    apiKey: 'k',
    keySource: 'account',
    systemPrompt: null,
  })),
}));
vi.mock('@/lib/ai/context', () => ({
  buildConversationContext: vi.fn(async () => [
    { role: 'user', content: '¿Qué días hay?' },
  ]),
}));
vi.mock('@/lib/ai/knowledge', () => ({
  retrieveKnowledge: vi.fn(async () => []),
}));
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }));
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: vi.fn(async () => {}) }));
vi.mock('@/lib/ai/tools/load', () => ({ loadAiToolset: mocks.loadAiToolset }));
vi.mock('@/lib/ai/tools/live', () => ({ loadLiveData: mocks.loadLiveData }));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => mocks.admin }));

import { POST } from './route';

const supabase = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { id: 'conv-1' }, error: null }),
      }),
    }),
  }),
};
const toolset = {
  tools: [
    {
      name: 'cabbity_health__find_availability',
      integrationSlug: 'cabbity-health',
    },
  ],
  integrations: [],
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

beforeEach(() => {
  mocks.requireRole.mockResolvedValue({
    supabase,
    accountId: 'acct-A',
    userId: 'user-1',
    role: 'agent',
  });
  mocks.loadAiToolset.mockResolvedValue(toolset);
  mocks.loadLiveData.mockResolvedValue([liveBlock]);
  mocks.generateReply.mockResolvedValue({
    text: 'Hola',
    handoff: false,
    usage: null,
    toolsUsed: [],
  });
});

describe('POST /api/ai/draft — n13.7', () => {
  it('puts the live block in the prompt and runs in draft mode', async () => {
    const res = await POST(
      new Request('http://localhost/api/ai/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: 'conv-1' }),
      })
    );
    expect(res.status).toBe(200);
    expect(mocks.loadLiveData.mock.calls[0][1]).toMatchObject({
      accountId: 'acct-A',
      conversationId: null,
    });
    const call = mocks.generateReply.mock.calls[0][0];
    expect(call.systemPrompt).toContain('Live data:');
    expect(call.systemPrompt).toContain('No results in this range.');
    expect(call.grounding).toEqual({ mode: 'draft', liveData: [liveBlock] });
  });
});
