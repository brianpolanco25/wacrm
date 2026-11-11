import type { ProviderResult } from '../types';
import { transcribeGemini } from '../providers/transcribe-gemini';
import { transcribeOpenAi } from '../providers/transcribe-openai';
import type { Transcriber } from './types';

/** One transcription call with the resolved transcriber (no retry). */
export async function transcribeAudio(args: {
  transcriber: Transcriber;
  bytes: Uint8Array;
  mimeType: string;
  timeoutMs: number;
}): Promise<ProviderResult> {
  const { transcriber, bytes, mimeType, timeoutMs } = args;
  const call = {
    apiKey: transcriber.apiKey,
    model: transcriber.model,
    bytes,
    mimeType,
    timeoutMs,
  };
  return transcriber.provider === 'gemini'
    ? transcribeGemini(call)
    : transcribeOpenAi(call);
}
