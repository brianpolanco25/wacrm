import { beforeEach, describe, expect, it, vi } from 'vitest'

// The playground is a third LLM faucet next to the draft route and the
// auto-reply bot. On a deployment that funds the provider key (supuesto
// S1) an unlogged turn is spend nobody can attribute, so every call
// lands in `ai_usage_log` with the account and the key source — and
// never at the cost of the reply the operator is waiting on.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  supabaseAdmin: vi.fn(),
  insert: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 }),
  ),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { aiDraft: {} },
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/ai/knowledge', () => ({
  retrieveKnowledge: vi.fn(async () => []),
}))
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }))
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: mocks.supabaseAdmin }))

// `logAiUsage` itself is NOT mocked: the assertions below are on the row
// that actually reaches the table.
import { POST } from './route'

const supabase = {}

function post(body: unknown) {
  return new Request('http://localhost/api/ai/playground', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const usage = { promptTokens: 40, completionTokens: 8, totalTokens: 48 }

function config(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openai',
    model: 'gpt-x',
    apiKey: 'sk-whatever',
    keySource: 'platform',
    systemPrompt: null,
    isActive: false,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  mocks.requireRole.mockResolvedValue({
    supabase,
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'agent',
    account: { id: 'acct-1', name: 'Acme' },
  })
  mocks.loadAiConfig.mockResolvedValue(config())
  mocks.generateReply.mockResolvedValue({
    text: 'hi there',
    handoff: false,
    usage,
  })
  mocks.insert.mockResolvedValue({ error: null })
  mocks.supabaseAdmin.mockReturnValue({ from: () => ({ insert: mocks.insert }) })
})

/** The log write is fire-and-forget; let its microtasks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('POST /api/ai/playground', () => {
  it('logs a platform-funded turn to ai_usage_log, scoped to the account', async () => {
    const res = await POST(post({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: 'hi there', handoff: false })

    await settle()
    expect(mocks.insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      conversation_id: null,
      mode: 'playground',
      provider: 'openai',
      model: 'gpt-x',
      key_source: 'platform',
      prompt_tokens: 40,
      completion_tokens: 8,
      total_tokens: 48,
    })
  })

  it('records the account as the payer when the account brought its own key', async () => {
    mocks.loadAiConfig.mockResolvedValue(
      config({ keySource: 'account', provider: 'anthropic', model: 'claude-x' }),
    )
    await POST(post({ messages: [{ role: 'user', content: 'hi' }] }))
    await settle()
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({
      account_id: 'acct-1',
      key_source: 'account',
      provider: 'anthropic',
      model: 'claude-x',
    })
  })

  it('still answers when the usage log cannot be written', async () => {
    // No service-role key configured: building the admin client throws.
    mocks.supabaseAdmin.mockImplementation(() => {
      throw new Error('supabaseUrl is required')
    })
    const res = await POST(post({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: 'hi there', handoff: false })
  })

  it('writes nothing when the provider reported no usage', async () => {
    mocks.generateReply.mockResolvedValue({
      text: 'hi there',
      handoff: false,
      usage: null,
    })
    await POST(post({ messages: [{ role: 'user', content: 'hi' }] }))
    await settle()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('logs nothing when the provider call fails', async () => {
    mocks.generateReply.mockRejectedValue(new Error('provider down'))
    await POST(post({ messages: [{ role: 'user', content: 'hi' }] }))
    await settle()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})
