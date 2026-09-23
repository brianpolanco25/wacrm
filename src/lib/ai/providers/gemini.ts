import { AiError, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared';

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
