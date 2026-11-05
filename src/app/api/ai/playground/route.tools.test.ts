import { beforeEach, describe, expect, it, vi } from 'vitest';

// n13.3 R28, R35, R37: el playground carga las herramientas con la cuenta
// de la sesión, devuelve `toolsUsed` y registra el uso sumado.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  generateReply: vi.fn(),
  loadAiToolset: vi.fn(),
  logAiUsage: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  admin: { tag: 'admin' },
  adminThrows: false,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'x' }, { status: 403 })),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { aiDraft: {} },
}));
vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: vi.fn(async () => ({
    provider: 'gemini',
    model: 'g',
    apiKey: 'k',
    keySource: 'platform',
    systemPrompt: null,
  })),
}));
vi.mock('@/lib/ai/knowledge', () => ({
  retrieveKnowledge: vi.fn(async () => []),
}));
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }));
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: mocks.logAiUsage }));
vi.mock('@/lib/ai/tools/load', () => ({ loadAiToolset: mocks.loadAiToolset }));
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => {
    if (mocks.adminThrows) throw new Error('no service role');
    return mocks.admin;
  },
}));

import { POST } from './route';
import { AiError } from '@/lib/ai/types';

const toolset = {
  tools: [{ name: 'health__search', integrationSlug: 'health' }],
  integrations: [],
};
const usage = { promptTokens: 30, completionTokens: 3, totalTokens: 33 };

const post = () =>
  POST(
    new Request('http://localhost/api/ai/playground', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `accountId` in the body is ignored: the account is the session's.
      body: JSON.stringify({
        accountId: 'acct-B',
        messages: [{ role: 'user', content: 'cita' }],
      }),
    })
  );

beforeEach(() => {
  mocks.adminThrows = false;
  mocks.requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acct-A',
    userId: 'user-1',
    role: 'agent',
  });
  mocks.generateReply.mockResolvedValue({
    text: 'Listo',
    handoff: false,
    usage,
    toolsUsed: [{ integration: 'Health', operation: 'search', ok: false }],
  });
});

describe('POST /api/ai/playground with tools', () => {
  it('loads tools for the session account and returns toolsUsed', async () => {
    mocks.loadAiToolset.mockResolvedValue(toolset);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reply: 'Listo',
      handoff: false,
      toolsUsed: [{ integration: 'Health', operation: 'search', ok: false }],
    });
    expect(mocks.loadAiToolset).toHaveBeenCalledWith(mocks.admin, 'acct-A', {
      mode: 'playground',
    });
    expect(mocks.generateReply.mock.calls[0][0].tools).toEqual({
      toolset,
      db: mocks.admin,
      accountId: 'acct-A',
    });
    expect(mocks.logAiUsage).toHaveBeenCalledTimes(1);
    expect(mocks.logAiUsage.mock.calls[0][1]).toMatchObject({
      accountId: 'acct-A',
      mode: 'playground',
      usage,
    });
  });

  it('without tools: plain generateReply call and no toolsUsed in the body', async () => {
    mocks.loadAiToolset.mockResolvedValue({ tools: [], integrations: [] });
    mocks.generateReply.mockResolvedValue({
      text: 'Hola',
      handoff: false,
      usage,
    });
    const res = await post();
    expect(await res.json()).toEqual({ reply: 'Hola', handoff: false });
    expect(Object.keys(mocks.generateReply.mock.calls[0][0]).sort()).toEqual([
      'config',
      'messages',
      'systemPrompt',
    ]);
  });

  it('without a service-role client there are no tools', async () => {
    mocks.adminThrows = true;
    mocks.generateReply.mockResolvedValue({
      text: 'Hola',
      handoff: false,
      usage: null,
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(mocks.loadAiToolset).not.toHaveBeenCalled();
    expect(mocks.generateReply.mock.calls[0][0]).not.toHaveProperty('tools');
  });

  it('a failed later tool round still logs the earlier usage (finding 6)', async () => {
    mocks.loadAiToolset.mockResolvedValue(toolset);
    const err = new AiError('down', { code: 'timeout', status: 504 });
    err.usage = usage;
    mocks.generateReply.mockRejectedValue(err);
    const res = await post();
    expect(res.status).toBe(504);
    expect(mocks.logAiUsage).toHaveBeenCalledTimes(1);
    expect(mocks.logAiUsage.mock.calls[0][1]).toMatchObject({
      accountId: 'acct-A',
      mode: 'playground',
      usage,
    });
  });
});
