import { beforeEach, describe, expect, it, vi } from 'vitest';

// n13.7 R9, R16, R32: el playground carga las lecturas en vivo, toma la
// evidencia previa del `trail` del cuerpo y devuelve `grounding`.

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
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: vi.fn(async () => {}) }));
vi.mock('@/lib/ai/tools/load', () => ({ loadAiToolset: mocks.loadAiToolset }));
vi.mock('@/lib/ai/tools/live', () => ({ loadLiveData: mocks.loadLiveData }));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => mocks.admin }));

import { POST } from './route';

const toolset = {
  tools: [
    {
      name: 'cabbity_health__find_availability',
      integrationSlug: 'cabbity-health',
      integrationName: 'Cabbity Health',
      operationKey: 'find_availability',
      method: 'GET',
      description: '',
      parameters: { type: 'object', properties: {} },
      declaredParams: [],
    },
  ],
  integrations: [
    {
      slug: 'cabbity-health',
      name: 'Cabbity Health',
      instructions: null,
      timezone: null,
    },
  ],
};
const liveBlock = {
  integrationSlug: 'cabbity-health',
  integrationName: 'Cabbity Health',
  operationKey: 'find_availability',
  timeZone: null,
  loadedAt: new Date('2026-11-10T14:00:00Z'),
  result: { ok: false },
  grounds: ['schedule'],
};

const post = (trail: unknown) =>
  POST(
    new Request('http://localhost/api/ai/playground', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'cancela mi cita' }],
        trail,
      }),
    })
  );

beforeEach(() => {
  mocks.requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acct-A',
    userId: 'user-1',
    role: 'agent',
  });
  mocks.loadAiToolset.mockResolvedValue(toolset);
  mocks.loadLiveData.mockResolvedValue([liveBlock]);
  mocks.generateReply.mockResolvedValue({
    text: '',
    handoff: true,
    usage: null,
    toolsUsed: [],
    grounding: 'handoff',
  });
});

describe('POST /api/ai/playground — n13.7', () => {
  it('loads live data for the session account (no conversation) and puts it in the prompt', async () => {
    const res = await post(undefined);
    expect(res.status).toBe(200);
    expect(mocks.loadLiveData.mock.calls[0][0]).toBe(mocks.admin);
    expect(mocks.loadLiveData.mock.calls[0][1]).toMatchObject({
      accountId: 'acct-A',
      toolset,
      conversationId: null,
    });
    const call = mocks.generateReply.mock.calls[0][0];
    expect(call.systemPrompt).toContain('could not be loaded');
    expect(call.grounding).toMatchObject({
      mode: 'playground',
      liveData: [liveBlock],
      priorEvidence: [],
    });
  });

  it('R32: a valid trail becomes prior evidence; malformed entries are dropped', async () => {
    await post([
      { slug: 'cabbity-health', operation: 'list_appointments', ok: true },
      { slug: 'cabbity-health', operation: 'cancel_appointment', ok: false },
      { slug: 'cabbity-health', operation: 'x', ok: true, blocked: 'policy' },
      'junk',
      { slug: 'cabbity-health', operation: 'find_availability', ok: true },
    ]);
    expect(
      mocks.generateReply.mock.calls[0][0].grounding.priorEvidence
    ).toEqual([
      { integrationSlug: 'cabbity-health', operationKey: 'list_appointments' },
      { integrationSlug: 'cabbity-health', operationKey: 'find_availability' },
    ]);
  });

  it('R32: more than 50 entries → only the last 50', async () => {
    const trail = Array.from({ length: 70 }, (_, i) => ({
      slug: 'cabbity-health',
      operation: `op_${i}`,
      ok: true,
    }));
    await post(trail);
    const ev = mocks.generateReply.mock.calls[0][0].grounding.priorEvidence;
    expect(ev).toHaveLength(50);
    expect(ev[0].operationKey).toBe('op_20');
  });

  it('returns grounding when the text guard acted', async () => {
    const body = await (await post(undefined)).json();
    expect(body).toEqual({
      reply: '',
      handoff: true,
      toolsUsed: [],
      grounding: 'handoff',
    });
  });
});
