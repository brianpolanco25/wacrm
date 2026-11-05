import { beforeEach, describe, expect, it, vi } from 'vitest';

// n13.3 R5, R28, R36: el borrador pide solo herramientas de lectura con la
// cuenta de la sesión y devuelve `toolsUsed`.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  generateReply: vi.fn(),
  loadAiToolset: vi.fn(),
  logAiUsage: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
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
    { role: 'user', content: '¿Mi cita?' },
  ]),
}));
vi.mock('@/lib/ai/knowledge', () => ({
  retrieveKnowledge: vi.fn(async () => []),
}));
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }));
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: mocks.logAiUsage }));
vi.mock('@/lib/ai/tools/load', () => ({ loadAiToolset: mocks.loadAiToolset }));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => mocks.admin }));

import { POST } from './route';
import { AiError } from '@/lib/ai/types';

const supabase = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { id: 'conv-1' }, error: null }),
      }),
    }),
  }),
};

const post = () =>
  POST(
    new Request('http://localhost/api/ai/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: 'conv-1' }),
    })
  );

beforeEach(() => {
  mocks.requireRole.mockResolvedValue({
    supabase,
    accountId: 'acct-A',
    userId: 'user-1',
    role: 'agent',
  });
});

describe('POST /api/ai/draft with tools', () => {
  it('asks for draft-mode (GET-only) tools of the session account and returns toolsUsed', async () => {
    const toolset = { tools: [{ name: 'health__search' }], integrations: [] };
    mocks.loadAiToolset.mockResolvedValue(toolset);
    mocks.generateReply.mockResolvedValue({
      text: 'Su cita es el lunes.',
      handoff: false,
      usage: null,
      toolsUsed: [{ integration: 'Health', operation: 'search', ok: true }],
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      draft: 'Su cita es el lunes.',
      toolsUsed: [{ integration: 'Health', operation: 'search', ok: true }],
    });
    expect(mocks.loadAiToolset).toHaveBeenCalledWith(mocks.admin, 'acct-A', {
      mode: 'draft',
    });
    expect(mocks.generateReply.mock.calls[0][0].tools).toEqual({
      toolset,
      db: mocks.admin,
      accountId: 'acct-A',
    });
  });

  it('without tools: plain call and the old body', async () => {
    mocks.loadAiToolset.mockResolvedValue({ tools: [], integrations: [] });
    mocks.generateReply.mockResolvedValue({
      text: 'Hola',
      handoff: false,
      usage: null,
    });
    const res = await post();
    expect(await res.json()).toEqual({ draft: 'Hola' });
    expect(Object.keys(mocks.generateReply.mock.calls[0][0]).sort()).toEqual([
      'config',
      'messages',
      'systemPrompt',
    ]);
  });

  it('a failed later tool round still logs the earlier usage (finding 6)', async () => {
    mocks.loadAiToolset.mockResolvedValue({
      tools: [{ name: 'health__search' }],
      integrations: [],
    });
    const usage = { promptTokens: 5, completionTokens: 1, totalTokens: 6 };
    const err = new AiError('down', { code: 'timeout', status: 504 });
    err.usage = usage;
    mocks.generateReply.mockRejectedValue(err);
    const res = await post();
    expect(res.status).toBe(504);
    expect(mocks.logAiUsage).toHaveBeenCalledTimes(1);
    expect(mocks.logAiUsage.mock.calls[0][1]).toMatchObject({
      accountId: 'acct-A',
      conversationId: 'conv-1',
      mode: 'draft',
      usage,
    });
  });
});
