import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiKeySource, AiProvider, AiUsage } from './types'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: 'auto_reply' | 'draft'
  provider: AiProvider
  model: string
  /** Which key paid for this call: the account's own ('account') or the
   *  deployment's ('platform', supuesto S1). Take it from
   *  `AiConfig.keySource` — never guess. */
  keySource: AiKeySource
  /** Provider usage; a no-op when null (nothing worth recording). */
  usage: AiUsage | null
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility. Every row carries `account_id` and `key_source`, so the
 * spend the platform funded (supuesto S1) can be told apart per account
 * from the spend an account put on its own key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 *
 * Pass the service-role admin client from the webhook, or the RLS-scoped
 * SSR client from a route — writes land either way (there's no
 * `authenticated` INSERT policy, so an SSR write relies on the service
 * role; callers that must persist from a route should pass the admin
 * client).
 */
export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage) return
  try {
    const { error } = await db.from('ai_usage_log').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      key_source: args.keySource,
      prompt_tokens: args.usage.promptTokens,
      completion_tokens: args.usage.completionTokens,
      total_tokens: args.usage.totalTokens,
    })
    if (error) {
      console.error('[ai usage] log insert failed:', error)
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err)
  }
}
