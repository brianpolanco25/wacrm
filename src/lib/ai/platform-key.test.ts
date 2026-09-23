import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_PLATFORM_KEY_ENV,
  hasPlatformApiKey,
  platformApiKey,
  resolveAiApiKey,
} from './platform-key';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('platformApiKey', () => {
  it('reads one variable per provider', () => {
    expect(AI_PLATFORM_KEY_ENV.openai).toBe('AI_PLATFORM_OPENAI_API_KEY');
    expect(AI_PLATFORM_KEY_ENV.anthropic).toBe('AI_PLATFORM_ANTHROPIC_API_KEY');
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    vi.stubEnv('AI_PLATFORM_ANTHROPIC_API_KEY', '');
    expect(platformApiKey('openai')).toBe('sk-platform');
    expect(platformApiKey('anthropic')).toBeNull();
    expect(hasPlatformApiKey('openai')).toBe(true);
    expect(hasPlatformApiKey('anthropic')).toBe(false);
  });

  it('reads AI_PLATFORM_GEMINI_API_KEY for gemini', () => {
    expect(AI_PLATFORM_KEY_ENV.gemini).toBe('AI_PLATFORM_GEMINI_API_KEY');
    vi.stubEnv('AI_PLATFORM_GEMINI_API_KEY', ' AIza-platform ');
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', '');
    expect(platformApiKey('gemini')).toBe('AIza-platform');
    expect(hasPlatformApiKey('gemini')).toBe(true);
    expect(resolveAiApiKey('gemini', null)).toEqual({
      key: 'AIza-platform',
      source: 'platform',
    });
    expect(resolveAiApiKey('gemini', 'AIza-own')).toEqual({
      key: 'AIza-own',
      source: 'account',
    });
    // The Gemini key never serves another provider.
    expect(resolveAiApiKey('openai', null)).toBeNull();
  });

  it('treats unset and whitespace-only values as not configured', () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', '   ');
    vi.stubEnv('AI_PLATFORM_ANTHROPIC_API_KEY', '');
    expect(platformApiKey('openai')).toBeNull();
    expect(platformApiKey('anthropic')).toBeNull();
  });
});

describe('resolveAiApiKey', () => {
  it('prefers the account key when present', () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    expect(resolveAiApiKey('openai', 'sk-own')).toEqual({
      key: 'sk-own',
      source: 'account',
    });
  });

  it('falls back to the platform key when the account has none', () => {
    vi.stubEnv('AI_PLATFORM_ANTHROPIC_API_KEY', 'sk-ant-platform');
    expect(resolveAiApiKey('anthropic', null)).toEqual({
      key: 'sk-ant-platform',
      source: 'platform',
    });
    expect(resolveAiApiKey('anthropic', '   ')).toEqual({
      key: 'sk-ant-platform',
      source: 'platform',
    });
  });

  it('returns null when neither exists (today\'s "not configured" path)', () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', '');
    expect(resolveAiApiKey('openai', null)).toBeNull();
    expect(resolveAiApiKey('openai', undefined)).toBeNull();
  });

  it("does not let one provider's platform key serve another provider", () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    vi.stubEnv('AI_PLATFORM_ANTHROPIC_API_KEY', '');
    expect(resolveAiApiKey('anthropic', null)).toBeNull();
  });
});
