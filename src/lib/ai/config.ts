import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveAiApiKey } from './platform-key';
import type { AiConfig, HandoffMode } from './types';

interface AiConfigRow {
  provider: 'openai' | 'anthropic';
  model: string;
  /** Encrypted BYO key, or null when the account relies on the platform key. */
  api_key: string | null;
  system_prompt: string | null;
  is_active: boolean;
  auto_reply_enabled: boolean;
  auto_reply_max_per_conversation: number;
  handoff_agent_id: string | null;
  handoff_mode: HandoffMode | null;
  handoff_message: string | null;
  embeddings_api_key: string | null;
}

const CONFIG_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, handoff_mode, handoff_message, embeddings_api_key';

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {}
): Promise<AiConfig | null> {
  const { requireActive = true } = opts;
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as AiConfigRow;
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null;
  // Key resolution (supuesto S1 — la IA la paga el servicio): the
  // account's own key wins; without one, the platform key for the
  // account's provider; without either, "not configured" — exactly the
  // pre-S1 behaviour. Only a stored key goes through decrypt(), so a
  // mismatched ENCRYPTION_KEY still surfaces as a throw, not as null.
  const resolvedKey = resolveAiApiKey(
    row.provider,
    row.api_key ? decrypt(row.api_key) : null
  );
  if (!resolvedKey) return null;

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null;
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key);
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`
      );
      embeddingsApiKey = null;
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: resolvedKey.key,
    // Who pays for this call. Rides along to `ai_usage_log.key_source`
    // so platform-funded spend is separable from BYO spend.
    keySource: resolvedKey.source,
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    // A row written before migration 043 (column absent/null in a mocked
    // read) keeps the pre-fase-1 semantics: a configured agent meant
    // "fixed", none meant "queue".
    handoffMode: row.handoff_mode ?? (row.handoff_agent_id ? 'fixed' : 'queue'),
    handoffAgentId: row.handoff_agent_id,
    handoffMessage: row.handoff_message ?? null,
    embeddingsApiKey,
  };
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string
): Promise<{ key: string | null; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false };
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false };
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`
    );
    return { key: null, corrupt: true };
  }
}
