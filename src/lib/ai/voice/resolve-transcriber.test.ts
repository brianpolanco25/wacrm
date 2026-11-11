import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDER_DEFAULT_MODEL } from '../defaults';
import type { AiConfig } from '../types';
import { resolveTranscriber, TRANSCRIBE_MIME } from './resolve-transcriber';

function cfg(over: Partial<AiConfig>): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    apiKey: 'sk-account',
    keySource: 'account',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 5,
    handoffMode: 'queue',
    handoffAgentId: null,
    handoffMessage: null,
    embeddingsApiKey: null,
    embeddingsProvider: 'openai',
    ...over,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('resolveTranscriber (R9–R11)', () => {
  it('openai with its own key → OpenAI, account key, transcribe model', () => {
    vi.stubEnv('AI_TRANSCRIBE_OPENAI_MODEL', '');
    expect(resolveTranscriber(cfg({}))).toEqual({
      provider: 'openai',
      apiKey: 'sk-account',
      keySource: 'account',
      model: 'gpt-4o-mini-transcribe',
    });
  });

  it('openai on the platform key keeps keySource platform', () => {
    expect(
      resolveTranscriber(cfg({ apiKey: 'sk-plat', keySource: 'platform' }))
    ).toMatchObject({
      provider: 'openai',
      apiKey: 'sk-plat',
      keySource: 'platform',
    });
  });

  it('gemini → Gemini with the config model, key and keySource', () => {
    expect(
      resolveTranscriber(
        cfg({
          provider: 'gemini',
          model: 'gemini-x',
          apiKey: 'g-key',
          keySource: 'platform',
        })
      )
    ).toEqual({
      provider: 'gemini',
      apiKey: 'g-key',
      keySource: 'platform',
      model: 'gemini-x',
    });
  });

  it('anthropic → OpenAI platform key when present', () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    vi.stubEnv('AI_PLATFORM_GEMINI_API_KEY', 'g-platform');
    expect(
      resolveTranscriber(cfg({ provider: 'anthropic', apiKey: 'ant' }))
    ).toEqual({
      provider: 'openai',
      apiKey: 'sk-platform',
      keySource: 'platform',
      model: 'gpt-4o-mini-transcribe',
    });
  });

  it('anthropic → Gemini platform key with the default Gemini model', () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', '');
    vi.stubEnv('AI_PLATFORM_GEMINI_API_KEY', 'g-platform');
    expect(
      resolveTranscriber(
        cfg({ provider: 'anthropic', apiKey: 'ant', keySource: 'account' })
      )
    ).toEqual({
      provider: 'gemini',
      apiKey: 'g-platform',
      keySource: 'platform',
      model: AI_PROVIDER_DEFAULT_MODEL.gemini,
    });
  });

  it('anthropic without platform keys → null', () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', '');
    vi.stubEnv('AI_PLATFORM_GEMINI_API_KEY', '');
    expect(resolveTranscriber(cfg({ provider: 'anthropic' }))).toBeNull();
  });
});

describe('TRANSCRIBE_MIME (R16)', () => {
  it('both accept audio/ogg; neither accepts audio/amr', () => {
    expect(TRANSCRIBE_MIME.openai.has('audio/ogg')).toBe(true);
    expect(TRANSCRIBE_MIME.gemini.has('audio/ogg')).toBe(true);
    expect(TRANSCRIBE_MIME.openai.has('audio/amr')).toBe(false);
    expect(TRANSCRIBE_MIME.gemini.has('audio/amr')).toBe(false);
  });
});
