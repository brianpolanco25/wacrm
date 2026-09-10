import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}));

import { loadAiConfig } from './config';

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return chain as unknown as SupabaseClient;
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
};

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull();
  });

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    });
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('openai');
    expect(config!.apiKey).toBe('plain:enc-key');
  });

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false })
    ).toBeNull();
  });
});

describe('loadAiConfig platform key fallback (supuesto S1)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const NO_KEY_ROW = { ...ROW, api_key: null, is_active: true };

  it('uses the platform key when the account has no stored key', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    const config = await loadAiConfig(dbReturning(NO_KEY_ROW), 'acct');
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBe('sk-platform');
  });

  it('prefers the stored key over the platform key', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    const config = await loadAiConfig(
      dbReturning({ ...ROW, is_active: true }),
      'acct'
    );
    expect(config!.apiKey).toBe('plain:enc-key');
  });

  it('returns null (not configured) when there is neither a stored nor a platform key', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', '');
    expect(await loadAiConfig(dbReturning(NO_KEY_ROW), 'acct')).toBeNull();
  });

  it("does not use another provider's platform key", async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    vi.stubEnv('AI_PLATFORM_ANTHROPIC_API_KEY', '');
    expect(
      await loadAiConfig(
        dbReturning({ ...NO_KEY_ROW, provider: 'anthropic' }),
        'acct'
      )
    ).toBeNull();
  });
});
