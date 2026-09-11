// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/**
 * Where the key that will be billed came from (supuesto S1 — la IA la
 * paga el servicio):
 *
 *   'account'  — the tenant's own key, stored AES-256-GCM-encrypted in
 *                `ai_configs.api_key`. The tenant pays the provider.
 *   'platform' — the deployment-wide key from the environment
 *                (`AI_PLATFORM_*_API_KEY`). The platform pays.
 *
 * Carried all the way to `ai_usage_log.key_source` so spend the platform
 * funded can be told apart from BYO spend when it is time to bill it.
 */
export type AiKeySource = 'account' | 'platform'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig`. `apiKey` is the plaintext key the provider will be
 * called with — either the account's own BYO key (stored
 * AES-256-GCM-encrypted at rest) or, when the account has none, the
 * platform key from the environment (never stored, never encrypted).
 * `keySource` says which of the two it is; never assume it is the
 * account's.
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  /** Which key `apiKey` is — and therefore who pays for the call. */
  keySource: AiKeySource
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
