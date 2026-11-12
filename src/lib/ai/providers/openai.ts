import { AiError, type ChatMessage, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  userImages,
  parseToolArguments,
  type ProviderArgs,
  type ProviderToolArgs,
  type ProviderToolResult,
} from './shared';
import type { ToolCall } from '../tools/types';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

type OpenAiContentPart =
  | {
      type: 'image_url';
      image_url: { url: string; detail: 'high' };
    }
  | { type: 'text'; text: string };

/**
 * n15.2 (R17): our transcript as Chat Completions messages. A `user` turn
 * with images → `content` array of `image_url` data URIs (`detail:
 * 'high'`: the main case is reading digits) then the text; every other
 * turn keeps `content` as a string, byte-for-byte as before.
 */
function toOpenAiMessages(
  messages: ChatMessage[]
): { role: 'user' | 'assistant'; content: string | OpenAiContentPart[] }[] {
  return mergeConsecutive(messages).map((m) => {
    const images = userImages(m);
    if (images.length === 0) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        ...images.map((i): OpenAiContentPart => ({
          type: 'image_url',
          image_url: {
            url: `data:${i.mimeType};base64,${i.data}`,
            detail: 'high',
          },
        })),
        { type: 'text', text: m.content },
      ],
    };
  });
}

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(
  args: ProviderArgs
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args;

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...toOpenAiMessages(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res);
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    });
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  });
  return { text, usage };
}

interface OpenAiToolMessage {
  role?: string;
  content?: string | null;
  tool_calls?: {
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: unknown };
  }[];
}

interface OpenAiToolResponse {
  choices?: { message?: OpenAiToolMessage; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * n13.3 (R11, R13): one round of Chat Completions with function tools.
 * Earlier rounds are replayed as the assistant `message` exactly as it
 * came back plus one `{role:'tool'}` message per call. `length` and
 * `content_filter` run no tools. No `parallel_tool_calls` and no `strict`
 * (D12): some reasoning models reject the former.
 */
export async function generateOpenAiWithTools(
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

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...toOpenAiMessages(messages),
          ...steps.flatMap((step) => [
            step.assistant,
            ...step.results.map((r) => ({
              role: 'tool',
              tool_call_id: r.callId,
              content: JSON.stringify(r.payload),
            })),
          ]),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        tools: tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        tool_choice: toolChoice,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res);
  }

  const data = (await res
    .json()
    .catch(() => null)) as OpenAiToolResponse | null;
  const choice = data?.choices?.[0];
  const message: OpenAiToolMessage = choice?.message ?? {
    role: 'assistant',
    content: null,
  };
  const text =
    typeof message.content === 'string' ? message.content.trim() : '';
  const cut =
    choice?.finish_reason === 'length' ||
    choice?.finish_reason === 'content_filter';
  const toolCalls: ToolCall[] = cut
    ? []
    : (Array.isArray(message.tool_calls) ? message.tool_calls : [])
        .filter(
          (c) =>
            c?.type === 'function' &&
            typeof c.id === 'string' &&
            typeof c.function?.name === 'string'
        )
        .map((c) => ({
          id: c.id!,
          name: c.function!.name!,
          args: parseToolArguments(c.function!.arguments),
        }));
  if (!text && toolCalls.length === 0) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    });
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  });
  return { text, toolCalls, usage, assistant: message };
}
