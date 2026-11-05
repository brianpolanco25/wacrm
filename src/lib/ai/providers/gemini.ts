import { AiError, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
  type ProviderToolArgs,
  type ProviderToolResult,
} from './shared';
import type { JsonSchema, ToolCall } from '../tools/types';

// Stable, stateless endpoint (`models/{model}:generateContent`). The newer
// Interactions API is deliberately not used.
const GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

/**
 * Map our transcript to Gemini `contents`: merge consecutive same-role
 * turns, rename `assistant` to Gemini's `model`, and drop leading model
 * turns (an agent greeting before the customer wrote) so the payload
 * always starts on `user` and is never empty — same trick as the
 * Anthropic adapter.
 */
function toGeminiContents(messages: ProviderArgs['messages']): GeminiContent[] {
  const merged = mergeConsecutive(messages);
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift();
  }
  if (merged.length === 0) {
    return [
      {
        role: 'user',
        parts: [{ text: '(The customer has not sent a message yet.)' }],
      },
    ];
  }
  return merged.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

/**
 * Call Gemini's `generateContent` with the caller's key. The key goes in
 * the `x-goog-api-key` header, never as `?key=` in the URL (URLs end up
 * in logs). Returns the raw text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateGemini(
  args: ProviderArgs
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args;
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiContents(messages),
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res);
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null;
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts
    ?.filter((p) => typeof p?.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
  if (!text) {
    const blocked =
      Boolean(data?.promptFeedback?.blockReason) ||
      candidate?.finishReason === 'SAFETY';
    throw new AiError(
      blocked
        ? "Gemini's safety filter blocked the response."
        : 'Gemini returned an empty response.',
      { code: 'empty_response' }
    );
  }
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  });
  return { text, usage };
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: unknown };
  [key: string]: unknown;
}

interface GeminiToolResponse {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/** Gemini's OpenAPI subset: upper-case types, `enum` only on strings. */
export function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: schema.type.toUpperCase() };
  if (schema.description) out.description = schema.description;
  if (schema.type === 'string' && schema.enum && schema.enum.length > 0) {
    out.format = 'enum';
    out.enum = [...schema.enum];
  }
  if (schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(schema.properties)) {
      properties[name] = toGeminiSchema(child);
    }
    out.properties = properties;
  }
  if (schema.required && schema.required.length > 0) {
    out.required = [...schema.required];
  }
  return out;
}

const hasProperties = (schema: JsonSchema) =>
  !!schema.properties && Object.keys(schema.properties).length > 0;

/**
 * n13.3 (R12, R13): one round of `generateContent` with function
 * declarations. Earlier rounds are replayed as the candidate `content`
 * exactly as it came back (with its `thoughtSignature`s), role `model`,
 * then ONE `user` content with a `functionResponse` per call. Any
 * `finishReason` other than `STOP` runs no tools.
 */
export async function generateGeminiWithTools(
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
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`;

  const contents: unknown[] = [
    ...toGeminiContents(messages),
    ...steps.flatMap((step) => [
      step.assistant,
      {
        role: 'user',
        parts: step.results.map((r) => ({
          functionResponse: {
            name: r.name,
            ...(r.callId.startsWith('gemini:') ? {} : { id: r.callId }),
            response: r.payload,
          },
        })),
      },
    ]),
  ];

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              ...(hasProperties(t.parameters)
                ? { parameters: toGeminiSchema(t.parameters) }
                : {}),
            })),
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: toolChoice === 'none' ? 'NONE' : 'AUTO',
          },
        },
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res);
  }

  const data = (await res
    .json()
    .catch(() => null)) as GeminiToolResponse | null;
  const candidate = data?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts
    : [];
  const text = parts
    .filter((p) => typeof p?.text === 'string' && p.thought !== true)
    .map((p) => p.text)
    .join('')
    .trim();
  const cut =
    typeof candidate?.finishReason === 'string' &&
    candidate.finishReason !== 'STOP';
  const toolCalls: ToolCall[] = cut
    ? []
    : parts
        .filter((p) => typeof p?.functionCall?.name === 'string')
        .map((p, i) => ({
          id:
            typeof p.functionCall!.id === 'string' && p.functionCall!.id
              ? p.functionCall!.id
              : `gemini:${i}`,
          name: p.functionCall!.name!,
          args: p.functionCall!.args ?? {},
        }));
  if (!text && toolCalls.length === 0) {
    throw new AiError(
      cut && candidate?.finishReason === 'SAFETY'
        ? "Gemini's safety filter blocked the response."
        : 'Gemini returned an empty response.',
      { code: 'empty_response' }
    );
  }
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  });
  return {
    text,
    toolCalls,
    usage,
    assistant: { ...(candidate?.content ?? { parts: [] }), role: 'model' },
  };
}
