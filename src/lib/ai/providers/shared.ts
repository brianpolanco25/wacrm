import { AiError, type AiUsage, type ChatMessage } from '../types';
import {
  INVALID_ARGS,
  type JsonSchema,
  type ToolCall,
  type ToolResultForModel,
} from '../tools/types';

// ============================================================
// Bits shared by the OpenAI, Anthropic and Gemini adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  timeoutMs: number;
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown;
  completion?: unknown;
  total?: unknown;
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const promptTokens = num(raw.prompt);
  const completionTokens = num(raw.completion);
  const total = num(raw.total);
  const totalTokens = total > 0 ? total : promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  });
}

interface ProviderErrorBody {
  error?:
    | string
    | {
        message?: string;
        /** Google APIs: `google.rpc.ErrorInfo` entries carry a `reason`. */
        details?: { reason?: string }[];
      };
}

/**
 * Google answers a malformed/unknown API key with **400** (not 401) and
 * `reason: "API_KEY_INVALID"` in the error details. OpenAI and Anthropic
 * never send that reason, so checking it is safe for every provider.
 */
function isGoogleInvalidKey(body: ProviderErrorBody | null): boolean {
  const err = body?.error;
  if (!err || typeof err === 'string' || !Array.isArray(err.details)) {
    return false;
  }
  return err.details.some((d) => d?.reason === 'API_KEY_INVALID');
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response
): Promise<AiError> {
  let detail = '';
  let body: ProviderErrorBody | null = null;
  try {
    body = (await res.json()) as ProviderErrorBody;
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '');
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res;
  const code =
    status === 401 ||
    status === 403 ||
    (status === 400 && isGoogleInvalidKey(body))
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error';
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'rate_limited'
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`;

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  });
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic and Gemini want alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

// ============================================================
// Tool calling (n13.3). Each adapter keeps its plain `generate<X>` intact
// (R14) and adds a sibling `generate<X>WithTools` built on these types.
// ============================================================

/** A tool as offered to the model, provider-neutral. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** One finished tool round: the provider's own assistant turn, opaque and
 *  re-sent untouched (thinking blocks, thought signatures), and the results
 *  of the calls it asked for. */
export interface ToolStep {
  assistant: unknown;
  results: ToolResultForModel[];
}

export interface ProviderToolArgs extends ProviderArgs {
  tools: ToolSpec[];
  steps: ToolStep[];
  /** `none` = the final round: the model must answer in text. */
  toolChoice: 'auto' | 'none';
}

export interface ProviderToolResult {
  /** Text of this round (the loop keeps only the final round's). */
  text: string;
  /** Calls to run; empty when the round ended for any other reason. */
  toolCalls: ToolCall[];
  usage: AiUsage | null;
  /** The provider-native assistant turn, for the next round. */
  assistant: unknown;
}

/** R37: add two usages; null only when neither reported anything. */
export function sumUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** OpenAI sends tool arguments as JSON text; anything unparsable is
 *  `INVALID_ARGS` so the loop can answer `invalid_arguments` (R17). */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return INVALID_ARGS;
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return INVALID_ARGS;
  }
}
