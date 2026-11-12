import { AiError, type ChatMessage, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  userImages,
  type ProviderArgs,
  type ProviderToolArgs,
  type ProviderToolResult,
} from './shared';
import type { ToolCall } from '../tools/types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicResponse {
  content?: { type?: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): AnthropicMessage[] {
  const merged = mergeConsecutive(messages);
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift();
  }
  if (merged.length === 0) {
    return [
      { role: 'user', content: '(The customer has not sent a message yet.)' },
    ];
  }
  return merged.map(toAnthropicMessage);
}

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content:
    | string
    | (
        | {
            type: 'image';
            source: { type: 'base64'; media_type: string; data: string };
          }
        | { type: 'text'; text: string }
      )[];
};

/** n15.2 (R18): a `user` turn with images → image blocks, then the text
 *  block (never empty: the marker is always there). Any other turn keeps
 *  `content` as a string, exactly as before. */
function toAnthropicMessage(m: ChatMessage): AnthropicMessage {
  const images = userImages(m);
  if (images.length === 0) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      ...images.map((i) => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: i.mimeType,
          data: i.data,
        },
      })),
      { type: 'text' as const, text: m.content },
    ],
  };
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(
  args: ProviderArgs
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args;

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: normalizeForAnthropic(messages),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res);
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null;
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    });
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  });
  return { text, usage };
}

interface AnthropicToolResponse {
  content?: {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * n13.3 (R10, R13): one round of the Messages API with client tools.
 * Earlier rounds are replayed as the assistant's full `content` array —
 * untouched, thinking blocks included — followed by ONE `user` message
 * holding every `tool_result` of that round. A round cut by `max_tokens`
 * or a `refusal` runs no tools.
 */
export async function generateAnthropicWithTools(
  args: ProviderToolArgs
): Promise<ProviderToolResult> {
  const {
    apiKey,
    model,
    systemPrompt,
    messages,
    timeoutMs,
    tools,
    steps,
    toolChoice,
  } = args;

  const transcript: unknown[] = [
    ...normalizeForAnthropic(messages),
    ...steps.flatMap((step) => [
      { role: 'assistant', content: step.assistant },
      {
        role: 'user',
        content: step.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.callId,
          content: JSON.stringify(r.payload),
          ...(r.isError ? { is_error: true } : {}),
        })),
      },
    ]),
  ];

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: transcript,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        tool_choice: { type: toolChoice },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res);
  }

  const data = (await res
    .json()
    .catch(() => null)) as AnthropicToolResponse | null;
  const content = Array.isArray(data?.content) ? data.content : [];
  const text = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  const cut =
    data?.stop_reason === 'max_tokens' || data?.stop_reason === 'refusal';
  const toolCalls: ToolCall[] = cut
    ? []
    : content
        .filter(
          (b) =>
            b?.type === 'tool_use' &&
            typeof b.id === 'string' &&
            typeof b.name === 'string'
        )
        .map((b) => ({ id: b.id!, name: b.name!, args: b.input ?? {} }));
  if (!text && toolCalls.length === 0) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    });
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  });
  return { text, toolCalls, usage, assistant: content };
}
