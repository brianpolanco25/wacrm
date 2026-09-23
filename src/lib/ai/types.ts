// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI, Anthropic or Google Gemini.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'gemini';

/** Every supported provider — the domain of `ai_configs.provider` (066). */
export const AI_PROVIDERS: readonly AiProvider[] = [
  'openai',
  'anthropic',
  'gemini',
];

/** Narrow untrusted input (a request body) to a supported provider. */
export function isAiProvider(value: unknown): value is AiProvider {
  return (
    typeof value === 'string' &&
    (AI_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Where auto-reply routes a conversation when the model hands off
 * (fase 1, migration 043):
 *   - `fixed` → the agent in `handoffAgentId`
 *   - `queue` → nobody; the thread stays in the shared queue
 *   - `auto`  → the online agent with the least open load, via the
 *               `pick_available_agent` RPC; falls back to `queue` when
 *               nobody is online.
 */
export type HandoffMode = 'fixed' | 'queue' | 'auto';

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
export type AiKeySource = 'account' | 'platform';

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
  provider: AiProvider;
  model: string;
  apiKey: string;
  /** Which key `apiKey` is — and therefore who pays for the call. */
  keySource: AiKeySource;
  systemPrompt: string | null;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyMaxPerConversation: number;
  /** How auto-reply picks the handoff target — see {@link HandoffMode}. */
  handoffMode: HandoffMode;
  /** Target for `handoffMode === 'fixed'`: an agent's `auth.users.id`.
   *  Ignored (may be null) in the other modes. */
  handoffAgentId: string | null;
  /** Text sent to the customer right before the bot hands off, so the
   *  thread doesn't just go silent. Null/empty → nothing is sent. */
  handoffMessage: string | null;
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null;
}

/** A single conversation turn; each adapter maps it to its provider's shape. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`), Anthropic (`input`/`output`) and Gemini
 * (`promptTokenCount`/`candidatesTokenCount`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string;
  usage: AiUsage | null;
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string;
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean;
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null;
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = opts.code ?? 'ai_error';
    this.status = opts.status ?? 502;
  }
}
