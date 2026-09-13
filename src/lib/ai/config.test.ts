import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}));

import { loadAiConfig } from './config';

/** Columns the last `select()` asked for — the read is the only place
 *  that decides what reaches `AiConfig`. */
let selectedColumns = '';

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: (columns: string) => {
      selectedColumns = columns;
      return chain;
    },
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
    // The origin travels with the config so the usage log can bill it.
    expect(config!.keySource).toBe('platform');
  });

  it('prefers the stored key over the platform key', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    const config = await loadAiConfig(
      dbReturning({ ...ROW, is_active: true }),
      'acct'
    );
    expect(config!.apiKey).toBe('plain:enc-key');
    expect(config!.keySource).toBe('account');
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

describe('loadAiConfig handoff columns (fase 1)', () => {
  const ACTIVE = { ...ROW, is_active: true };

  it('selects the handoff columns — dropping one would kill the feature silently', async () => {
    await loadAiConfig(dbReturning(ACTIVE), 'acct');
    const columns = selectedColumns.split(',').map((c) => c.trim());
    expect(columns).toContain('handoff_mode');
    expect(columns).toContain('handoff_message');
    expect(columns).toContain('handoff_agent_id');
  });

  it('maps the stored mode, target and transition message', async () => {
    const config = await loadAiConfig(
      dbReturning({
        ...ACTIVE,
        handoff_mode: 'auto',
        handoff_agent_id: 'agent-7',
        handoff_message: 'A teammate is taking over.',
      }),
      'acct'
    );
    expect(config).toMatchObject({
      handoffMode: 'auto',
      handoffAgentId: 'agent-7',
      handoffMessage: 'A teammate is taking over.',
    });
  });

  it('keeps an empty message as an opt-out, not as "unset"', async () => {
    const config = await loadAiConfig(
      dbReturning({ ...ACTIVE, handoff_mode: 'queue', handoff_message: '' }),
      'acct'
    );
    expect(config!.handoffMessage).toBe('');
  });

  it('falls back to the pre-043 semantics on a row without the columns', async () => {
    // No handoff_mode/handoff_message at all (a read against a database
    // where 043 has not been applied yet).
    const queued = await loadAiConfig(dbReturning(ACTIVE), 'acct');
    expect(queued).toMatchObject({
      handoffMode: 'queue',
      handoffMessage: null,
    });

    const fixed = await loadAiConfig(
      dbReturning({ ...ACTIVE, handoff_agent_id: 'agent-7' }),
      'acct'
    );
    // A configured agent used to mean "fixed"; nothing else did.
    expect(fixed!.handoffMode).toBe('fixed');
    expect(fixed!.handoffMessage).toBeNull();
  });
});
