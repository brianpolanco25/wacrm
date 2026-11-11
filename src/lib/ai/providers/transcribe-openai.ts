import type { ProviderResult } from '../types';
import { extensionForMime } from '@/lib/media/filename';
import { normalizeUsage, providerHttpError, toNetworkError } from './shared';
import { TranscribeHttpError } from './transcribe-errors';

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

export interface TranscribeArgs {
  apiKey: string;
  model: string;
  bytes: Uint8Array;
  /** Normalized MIME (no parameters), e.g. `audio/ogg`. */
  mimeType: string;
  timeoutMs: number;
}

interface OpenAiTranscriptionResponse {
  text?: string;
  usage?: {
    type?: string;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * n15.1 (R17): ONE call to OpenAI's transcription endpoint. The retry of
 * R19 lives in the orchestrator, not here. The file name carries the
 * extension because the API picks the decoder from it. An empty `text`
 * is returned as-is: the orchestrator decides that it is `empty`.
 *
 * `whisper-1` reports usage in seconds, not tokens; `normalizeUsage`
 * then finds no token counts and returns null (no cost row is written).
 */
export async function transcribeOpenAi(
  args: TranscribeArgs
): Promise<ProviderResult> {
  const { apiKey, model, bytes, mimeType, timeoutMs } = args;
  const form = new FormData();
  form.append(
    'file',
    new Blob([bytes as unknown as BlobPart], { type: mimeType }),
    `voice.${extensionForMime(mimeType)}`
  );
  form.append('model', model);
  form.append('response_format', 'json');

  let res: Response;
  try {
    res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw new TranscribeHttpError(
      await providerHttpError('OpenAI', res),
      res.status
    );
  }

  const data = (await res
    .json()
    .catch(() => null)) as OpenAiTranscriptionResponse | null;
  const text = typeof data?.text === 'string' ? data.text : '';
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
    total: data?.usage?.total_tokens,
  });
  return { text, usage };
}
