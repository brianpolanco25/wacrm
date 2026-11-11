import { beforeEach, describe, expect, it, vi } from 'vitest';

// n15.1 (R36): the playground simulates a voice note with typed text —
// the turn reaches the model marked as one, the prompt explains the
// marker, and nothing is transcribed or billed as `transcription`.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  retrieveKnowledge: vi.fn<(...args: unknown[]) => Promise<string[]>>(
    async () => []
  ),
  buildSystemPrompt: vi.fn(),
  insert: vi.fn(async () => ({ error: null })),
  ensureVoiceTranscript: vi.fn(),
  transcribeAudio: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { aiDraft: {} },
}));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }));
vi.mock('@/lib/ai/knowledge', () => ({
  retrieveKnowledge: mocks.retrieveKnowledge,
}));
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }));
vi.mock('@/lib/ai/tools/load', () => ({
  loadAiToolset: vi.fn(async () => ({ tools: [], integrations: [] })),
}));
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({ insert: mocks.insert }) }),
}));
vi.mock('@/lib/ai/defaults', async (orig) => {
  const real = await orig<typeof import('@/lib/ai/defaults')>();
  mocks.buildSystemPrompt.mockImplementation(real.buildSystemPrompt);
  return { ...real, buildSystemPrompt: mocks.buildSystemPrompt };
});
vi.mock('@/lib/ai/voice/ensure-transcript', () => ({
  ensureVoiceTranscript: mocks.ensureVoiceTranscript,
}));
vi.mock('@/lib/ai/voice/transcribe', () => ({
  transcribeAudio: mocks.transcribeAudio,
}));

import { POST } from './route';

function post(body: unknown) {
  return new Request('http://localhost/api/ai/playground', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'agent',
  });
  mocks.loadAiConfig.mockResolvedValue({
    provider: 'openai',
    model: 'gpt-x',
    apiKey: 'sk',
    keySource: 'platform',
    systemPrompt: null,
  });
  mocks.generateReply.mockResolvedValue({
    text: 'Claro',
    handoff: false,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  });
});

describe('POST /api/ai/playground — simulated voice notes (R36)', () => {
  it('passes a voice user turn as [nota de voz] and turns on the prompt paragraph', async () => {
    const res = await POST(
      post({
        messages: [
          { role: 'assistant', content: 'Hola' },
          { role: 'user', content: '  cita el jueves ', voice: true },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(mocks.generateReply.mock.calls[0][0].messages).toEqual([
      { role: 'assistant', content: 'Hola' },
      { role: 'user', content: '[nota de voz] cita el jueves', voice: true },
    ]);
    expect(mocks.buildSystemPrompt.mock.calls[0][0]).toMatchObject({
      voiceNotes: true,
    });
    expect(mocks.buildSystemPrompt.mock.results[0].value).toContain(
      '"[nota de voz]"'
    );
    // Knowledge is queried with the plain text.
    expect(mocks.retrieveKnowledge.mock.calls[0][3]).toBe('cita el jueves');
  });

  it('ignores voice on an assistant turn and a non-boolean voice', async () => {
    await POST(
      post({
        messages: [
          { role: 'assistant', content: 'Hola', voice: true },
          { role: 'user', content: 'hola', voice: 'yes' },
        ],
      })
    );
    expect(mocks.generateReply.mock.calls[0][0].messages).toEqual([
      { role: 'assistant', content: 'Hola' },
      { role: 'user', content: 'hola' },
    ]);
    expect(mocks.buildSystemPrompt.mock.calls[0][0]).toMatchObject({
      voiceNotes: false,
    });
  });

  it('never transcribes and never logs a transcription row', async () => {
    await POST(
      post({ messages: [{ role: 'user', content: 'cita', voice: true }] })
    );
    await settle();
    expect(mocks.ensureVoiceTranscript).not.toHaveBeenCalled();
    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
    const modes = (
      mocks.insert.mock.calls as unknown as [{ mode: string }][]
    ).map((c) => c[0].mode);
    expect(modes).toEqual(['playground']);
  });
});
