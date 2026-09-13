import type { AiKeySource, AiProvider } from './types';

// ============================================================
// Platform-level provider keys (supuesto S1: la IA la paga el servicio).
//
// An account may still bring its own key (`ai_configs.api_key`). When it
// doesn't, the server falls back to a platform key for the account's
// provider, read from the environment. One variable per provider,
// because the account picks the provider and a single OpenAI key is
// useless to an account that chose Anthropic:
//
//   AI_PLATFORM_OPENAI_API_KEY      used when provider = 'openai'
//   AI_PLATFORM_ANTHROPIC_API_KEY   used when provider = 'anthropic'
//
// Resolution order, everywhere the key is needed (auto-reply, draft,
// playground, "Test key", save):
//   1. the account's own key      → `source: 'account'`
//   2. the platform key           → `source: 'platform'`
//   3. neither                    → AI not configured (today's behaviour)
//
// Server-only: never expose these values to the client. Routes may
// report `hasPlatformApiKey(provider)` (a boolean), never the key.
// ============================================================

export const AI_PLATFORM_KEY_ENV: Record<AiProvider, string> = {
  openai: 'AI_PLATFORM_OPENAI_API_KEY',
  anthropic: 'AI_PLATFORM_ANTHROPIC_API_KEY',
};

/** The platform key for `provider`, or null when it is not configured. */
export function platformApiKey(provider: AiProvider): string | null {
  const raw = process.env[AI_PLATFORM_KEY_ENV[provider]];
  const key = typeof raw === 'string' ? raw.trim() : '';
  return key ? key : null;
}

export function hasPlatformApiKey(provider: AiProvider): boolean {
  return platformApiKey(provider) !== null;
}

// `AiKeySource` lives in ./types with `AiConfig` (the shape that
// carries it around); re-exported here so callers of `resolveAiApiKey`
// get it from the same module.
export type { AiKeySource };

/**
 * Pick the key to call the provider with: the account's own (plaintext)
 * key when present, else the platform key, else null.
 */
export function resolveAiApiKey(
  provider: AiProvider,
  accountKey: string | null | undefined
): { key: string; source: AiKeySource } | null {
  const own = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (own) return { key: own, source: 'account' };
  const platform = platformApiKey(provider);
  if (platform) return { key: platform, source: 'platform' };
  return null;
}
