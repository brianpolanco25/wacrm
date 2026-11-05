import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types';
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults';
import { generateOpenAi } from './providers/openai';
import { generateAnthropic } from './providers/anthropic';
import { generateGemini } from './providers/gemini';
import { runToolLoop } from './tools/loop';
import type { AiToolset } from './tools/types';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface GenerateArgs {
  config: AiConfig;
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string;
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[];
  /** n13.3: integration tools for this turn. Without it, or with an empty
   *  toolset, the path is exactly the one before n13.3 (R14). */
  tools?: { toolset: AiToolset; db: SupabaseClient; accountId: string };
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(
  args: GenerateArgs
): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args;

  if (args.tools && args.tools.toolset.tools.length > 0) {
    const looped = await runToolLoop({
      config,
      systemPrompt,
      messages,
      toolset: args.tools.toolset,
      db: args.tools.db,
      accountId: args.tools.accountId,
    });
    return {
      ...parseGeneration(looped.text, looped.usage),
      toolsUsed: looped.toolsUsed,
    };
  }

  const timeoutMs = aiRequestTimeoutMs();
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  };

  let result: { text: string; usage: AiUsage | null };
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs);
      break;
    case 'anthropic':
      result = await generateAnthropic(providerArgs);
      break;
    case 'gemini':
      result = await generateGemini(providerArgs);
      break;
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      });
  }

  return parseGeneration(result.text, result.usage);
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL);
  const text = raw.split(HANDOFF_SENTINEL).join('').trim();
  return { text, handoff, usage };
}
