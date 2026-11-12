import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// n15.2 (R27, R29, R32–R34): the playground accepts a test image per user
// turn, validates it before anything else, sends bytes only for the most
// recent ones, and never echoes them back.

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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString(
  'base64'
);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]).toString('base64');
const jpeg = { mimeType: 'image/jpeg', data: JPEG };
const sent = () =>
  mocks.generateReply.mock.calls[0][0].messages as Record<string, unknown>[];

afterEach(() => vi.unstubAllEnvs());

describe('POST /api/ai/playground — test images (n15.2)', () => {
  it('a valid image becomes an [imagen] turn with bytes, images: true in the prompt (R27, R32)', async () => {
    const res = await POST(
      post({
        messages: [
          { role: 'assistant', content: 'Hola' },
          { role: 'user', content: ' mi cédula ', image: jpeg },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(sent()).toEqual([
      { role: 'assistant', content: 'Hola' },
      {
        role: 'user',
        content: '[imagen] mi cédula',
        image: { playground: true },
        images: [{ mimeType: 'image/jpeg', data: JPEG }],
      },
    ]);
    expect(mocks.buildSystemPrompt.mock.calls[0][0]).toMatchObject({
      images: true,
    });
    expect(mocks.buildSystemPrompt.mock.results[0].value).toContain(
      '"[imagen]"'
    );
    // Knowledge is queried with the caption, not the marker (R15).
    expect(mocks.retrieveKnowledge.mock.calls[0][3]).toBe('mi cédula');
  });

  it('accepts an image with empty text (R32)', async () => {
    const res = await POST(
      post({ messages: [{ role: 'user', content: '', image: jpeg }] })
    );
    expect(res.status).toBe(200);
    expect(sent()[0]).toMatchObject({ content: '[imagen]' });
  });

  it.each([
    ['a MIME outside the list', { mimeType: 'image/gif', data: JPEG }],
    ['broken base64', { mimeType: 'image/jpeg', data: '@@@@' }],
    ['a signature that does not match', { mimeType: 'image/jpeg', data: PNG }],
    [
      'more than 2 MiB',
      {
        mimeType: 'image/jpeg',
        data: Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff]),
          Buffer.alloc(2 * 1024 * 1024),
        ]).toString('base64'),
      },
    ],
    ['not an object', 'data:image/jpeg;base64,' + JPEG],
  ])('%s → 400 invalid_image, no provider call (R33)', async (_, image) => {
    const res = await POST(
      post({ messages: [{ role: 'user', content: 'x', image }] })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_image' });
    expect(mocks.loadAiConfig).not.toHaveBeenCalled();
    expect(mocks.generateReply).not.toHaveBeenCalled();
  });

  it('only the 3 most recent images carry bytes; imageOmitted is unavailable; assistant image ignored (R34)', async () => {
    vi.stubEnv('AI_IMAGE_MAX_PER_TURN', '');
    await POST(
      post({
        messages: [
          { role: 'user', content: 'vieja', imageOmitted: true },
          { role: 'user', content: 'a', image: jpeg },
          { role: 'assistant', content: 'ok', image: jpeg },
          { role: 'user', content: 'b', image: jpeg },
          { role: 'user', content: 'c', image: jpeg },
          { role: 'user', content: 'd', image: jpeg },
        ],
      })
    );
    const turns = sent();
    expect(turns.map((t) => t.content)).toEqual([
      '[imagen no disponible] vieja',
      '[imagen no disponible] a',
      'ok',
      '[imagen] b',
      '[imagen] c',
      '[imagen] d',
    ]);
    expect(turns.filter((t) => t.images).length).toBe(3);
    expect(turns[0]).not.toHaveProperty('images');
    expect(turns[2]).toEqual({ role: 'assistant', content: 'ok' });
  });

  it('AI_IMAGE_MAX_PER_TURN=0 sends no bytes (R34)', async () => {
    vi.stubEnv('AI_IMAGE_MAX_PER_TURN', '0');
    await POST(
      post({ messages: [{ role: 'user', content: '', image: jpeg }] })
    );
    expect(sent()[0]).toEqual({
      role: 'user',
      content: '[imagen no disponible]',
      image: { playground: true },
    });
  });

  it('the response never echoes the image (R29)', async () => {
    const res = await POST(
      post({ messages: [{ role: 'user', content: 'x', image: jpeg }] })
    );
    const raw = await res.text();
    expect(raw).not.toContain(JPEG);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['handoff', 'reply']);
  });

  it('without images the prompt flag is false', async () => {
    await POST(post({ messages: [{ role: 'user', content: 'hola' }] }));
    expect(mocks.buildSystemPrompt.mock.calls[0][0]).toMatchObject({
      images: false,
    });
    expect(sent()).toEqual([{ role: 'user', content: 'hola' }]);
  });
});
