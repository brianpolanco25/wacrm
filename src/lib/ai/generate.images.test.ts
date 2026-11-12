import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiError, type AiConfig, type ChatMessage } from './types';

// n15.2 R22–R24, R31: gate de visión y reintento único sin imágenes.

const openai = vi.hoisted(() => vi.fn());
const anthropic = vi.hoisted(() => vi.fn());
const gemini = vi.hoisted(() => vi.fn());
const loop = vi.hoisted(() => vi.fn());
vi.mock('./providers/openai', () => ({ generateOpenAi: openai }));
vi.mock('./providers/anthropic', () => ({ generateAnthropic: anthropic }));
vi.mock('./providers/gemini', () => ({ generateGemini: gemini }));
vi.mock('./tools/loop', () => ({ runToolLoop: loop }));

import { generateReply } from './generate';

const IMG = { mimeType: 'image/jpeg' as const, data: 'QUJD' };
const USAGE = { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
const RETRY_USAGE = { promptTokens: 7, completionTokens: 2, totalTokens: 9 };

function config(over: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'sk',
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
    ...over,
  };
}

const withImage: ChatMessage[] = [
  { role: 'user', content: 'hola' },
  {
    role: 'user',
    content: '[imagen] mi cédula',
    image: { messageId: 'm1', mediaUrl: null, mediaType: 'image/jpeg' },
    images: [IMG],
  },
];
const stripped: ChatMessage[] = [
  { role: 'user', content: 'hola' },
  {
    role: 'user',
    content: '[imagen no disponible] mi cédula',
    image: { messageId: 'm1', mediaUrl: null, mediaType: 'image/jpeg' },
  },
];

const providerError = (usage: typeof USAGE | null = null) => {
  const e = new AiError('OpenAI API error (400): image', {
    code: 'provider_error',
  });
  e.usage = usage;
  return e;
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const sentMessages = (fn: typeof openai, call = 0) =>
  (fn.mock.calls[call][0] as { messages: ChatMessage[] }).messages;

describe('generateReply — vision gate (R22)', () => {
  it('without images: one call with the messages as given', async () => {
    openai.mockResolvedValue({ text: 'ok', usage: USAGE });
    const messages: ChatMessage[] = [{ role: 'user', content: 'hola' }];
    await generateReply({ config: config(), systemPrompt: 'S', messages });
    expect(openai).toHaveBeenCalledTimes(1);
    expect(sentMessages(openai)).toBe(messages);
  });

  it('with images on a vision model: one call with the images', async () => {
    gemini.mockResolvedValue({ text: 'ok', usage: USAGE });
    const r = await generateReply({
      config: config({ provider: 'gemini', model: 'gemini-2.5-flash' }),
      systemPrompt: 'S',
      messages: withImage,
    });
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(sentMessages(gemini)).toEqual(withImage);
    expect(r.usage).toEqual(USAGE);
  });

  it('a no-vision model: one call without images, markers unavailable', async () => {
    anthropic.mockResolvedValue({ text: 'ok', usage: USAGE });
    await generateReply({
      config: config({ provider: 'anthropic', model: 'claude-2.1' }),
      systemPrompt: 'S',
      messages: withImage,
    });
    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(sentMessages(anthropic)).toEqual(stripped);
  });
});

describe('generateReply — retry without images (R23, R24, R31)', () => {
  it('provider_error with usage null → one retry without images, its usage', async () => {
    openai.mockRejectedValueOnce(providerError()).mockResolvedValueOnce({
      text: 'Tu cédula termina en 5',
      usage: RETRY_USAGE,
    });
    const r = await generateReply({
      config: config(),
      systemPrompt: 'S',
      messages: withImage,
    });
    expect(openai).toHaveBeenCalledTimes(2);
    expect(sentMessages(openai, 0)).toEqual(withImage);
    expect(sentMessages(openai, 1)).toEqual(stripped);
    expect(r).toEqual({
      text: 'Tu cédula termina en 5',
      handoff: false,
      usage: RETRY_USAGE,
    });
  });

  it('a failing retry propagates its error', async () => {
    const second = new AiError('again', { code: 'provider_error' });
    openai.mockRejectedValueOnce(providerError()).mockRejectedValueOnce(second);
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'S',
        messages: withImage,
      })
    ).rejects.toBe(second);
    expect(openai).toHaveBeenCalledTimes(2);
  });

  it.each(['rate_limited', 'invalid_key', 'timeout', 'network_error'])(
    '%s → no retry',
    async (code) => {
      const err = new AiError(code, { code });
      openai.mockRejectedValueOnce(err);
      await expect(
        generateReply({
          config: config(),
          systemPrompt: 'S',
          messages: withImage,
        })
      ).rejects.toBe(err);
      expect(openai).toHaveBeenCalledTimes(1);
    }
  );

  it('provider_error marked toolsRan (usage null) → no retry', async () => {
    const err = providerError();
    err.toolsRan = true;
    openai.mockRejectedValueOnce(err);
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'S',
        messages: withImage,
      })
    ).rejects.toBe(err);
    expect(openai).toHaveBeenCalledTimes(1);
  });

  it('provider_error after a tool round (usage set) → no retry', async () => {
    const err = providerError(USAGE);
    loop.mockRejectedValueOnce(err);
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'S',
        messages: withImage,
        tools: {
          toolset: { tools: [{}] } as never,
          db: {} as never,
          accountId: 'A',
        },
      })
    ).rejects.toBe(err);
    expect(loop).toHaveBeenCalledTimes(1);
  });

  it('provider_error without images → no retry (path of before)', async () => {
    const err = providerError();
    openai.mockRejectedValueOnce(err);
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'S',
        messages: [{ role: 'user', content: 'hola' }],
      })
    ).rejects.toBe(err);
    expect(openai).toHaveBeenCalledTimes(1);
  });
});
