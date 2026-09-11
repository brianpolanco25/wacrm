import { afterEach, describe, it, expect, vi } from 'vitest'

// decrypt is identity-ish in tests so the chain below doesn't depend on
// real ciphertext (same convention as config.test.ts).
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { logAiUsage } from './usage'
import { loadAiConfig } from './config'
import type { SupabaseClient } from '@supabase/supabase-js'

function fakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const db = { from: vi.fn(() => ({ insert })) }
  return { db: db as unknown as SupabaseClient, insert, from: db.from }
}

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    const { db, insert, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      keySource: 'account',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    expect(from).toHaveBeenCalledWith('ai_usage_log')
    expect(insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      key_source: 'account',
      prompt_tokens: 30,
      completion_tokens: 6,
      total_tokens: 36,
    })
  })

  it('is a no-op when the provider reported no usage', async () => {
    const { db, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      keySource: 'platform',
      usage: null,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('never throws when the insert errors', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    await expect(
      logAiUsage(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        keySource: 'account',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Supuesto S1 (la IA la paga el servicio): usage funded by the platform key
// has to be separable, per account, from usage an account put on its own key
// — otherwise fase 3 cannot bill it. The origin is computed once in
// `loadAiConfig` and travels to `ai_usage_log.key_source`; this exercises the
// whole chain, not just the insert.
// ---------------------------------------------------------------------------

function dbReturning(row: Record<string, unknown>): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const CONFIG_ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: null as string | null,
  system_prompt: null,
  is_active: true,
  auto_reply_enabled: true,
  auto_reply_max_per_conversation: 3,
  handoff_agent_id: null,
  embeddings_api_key: null,
}

/** Load a config the way auto-reply does, then log one call with it. */
async function logOneCall(
  row: Record<string, unknown>,
  accountId: string,
): Promise<Record<string, unknown>> {
  const config = await loadAiConfig(dbReturning(row), accountId)
  expect(config).not.toBeNull()
  const { db, insert } = fakeDb()
  await logAiUsage(db, {
    accountId,
    conversationId: 'conv-1',
    mode: 'auto_reply',
    provider: config!.provider,
    model: config!.model,
    keySource: config!.keySource,
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  })
  return insert.mock.calls[0][0] as Record<string, unknown>
}

describe('ai_usage_log.key_source', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('tells a call paid by the platform apart from one paid by the account, both scoped to their account', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform')

    const platformRow = await logOneCall(CONFIG_ROW, 'acct-platform')
    const accountRow = await logOneCall(
      { ...CONFIG_ROW, api_key: 'enc-own' },
      'acct-byo',
    )

    expect(platformRow).toMatchObject({
      account_id: 'acct-platform',
      key_source: 'platform',
    })
    expect(accountRow).toMatchObject({
      account_id: 'acct-byo',
      key_source: 'account',
    })
    // Neither row may leak the key itself, whoever paid for it.
    expect(JSON.stringify([platformRow, accountRow])).not.toContain(
      'sk-platform',
    )
  })

  it('keeps the account key as the source even when a platform key exists', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform')
    const row = await logOneCall(
      { ...CONFIG_ROW, api_key: 'enc-own' },
      'acct-1',
    )
    expect(row.key_source).toBe('account')
  })
})
