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
import { modelSupportsVision, withoutImages } from './images/vision';
import type {
  AiToolMode,
  AiToolset,
  LiveDataBlock,
  PriorEvidence,
} from './tools/types';
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
  /** n13.7: guardias del turno con herramientas (modo, lecturas en vivo,
   *  evidencia previa del playground, conversación). Solo con `tools`. */
  grounding?: {
    mode: AiToolMode;
    liveData?: LiveDataBlock[];
    priorEvidence?: PriorEvidence[];
    conversationId?: string | null;
  };
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 *
 * n15.2 (R22–R24, R31): a turn with images goes through the vision gate.
 * A model on the no-vision list gets the transcript without images (one
 * call). Otherwise, a `provider_error` with no finished tool round
 * (`err.usage === null`) is retried ONCE without images — never after a
 * tool ran, which could book an appointment twice (D5). Without images
 * the path is exactly the one before n15.2.
 */
export async function generateReply(
  args: GenerateArgs
): Promise<GenerateResult> {
  const hasImages = args.messages.some((m) => m.images?.length);
  if (!hasImages) return generateOnce(args);
  if (!modelSupportsVision(args.config.provider, args.config.model)) {
    return generateOnce({ ...args, messages: withoutImages(args.messages) });
  }
  try {
    return await generateOnce(args);
  } catch (err) {
    if (
      err instanceof AiError &&
      err.code === 'provider_error' &&
      err.usage === null
    ) {
      console.warn(
        '[ai] provider rejected the image turn; retrying without images'
      );
      return generateOnce({ ...args, messages: withoutImages(args.messages) });
    }
    throw err;
  }
}

async function generateOnce(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args;

  if (args.tools && args.tools.toolset.tools.length > 0) {
    const looped = await runToolLoop({
      config,
      systemPrompt,
      messages,
      toolset: args.tools.toolset,
      db: args.tools.db,
      accountId: args.tools.accountId,
      ...(args.grounding ?? {}),
    });
    return {
      ...parseGeneration(looped.text, looped.usage),
      toolsUsed: looped.toolsUsed,
      ...(looped.grounding ? { grounding: looped.grounding } : {}),
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
