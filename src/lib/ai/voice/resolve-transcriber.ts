import { AI_PROVIDER_DEFAULT_MODEL } from '../defaults';
import { platformApiKey } from '../platform-key';
import type { AiConfig } from '../types';
import { aiTranscribeOpenAiModel } from './config';
import type { Transcriber } from './types';

/**
 * MIME types (normalized, no parameters) each transcriber accepts
 * (design §4.3). WhatsApp voice notes are `audio/ogg`, covered by both;
 * `audio/amr` is in neither → `skipped/unsupported_format` (R16).
 */
export const TRANSCRIBE_MIME: Record<
  Transcriber['provider'],
  ReadonlySet<string>
> = {
  openai: new Set([
    'audio/ogg',
    'audio/mpeg',
    'audio/mp4',
    'audio/m4a',
    'audio/wav',
    'audio/webm',
    'audio/flac',
  ]),
  gemini: new Set([
    'audio/ogg',
    'audio/mpeg',
    'audio/wav',
    'audio/aac',
    'audio/flac',
    'audio/aiff',
  ]),
};

/**
 * Who transcribes this account's voice notes (R9–R11, D2):
 *   - openai    → OpenAI with the account's key and `keySource`;
 *   - gemini    → Gemini with the account's key, `keySource` and model;
 *   - anthropic → no audio API: OpenAI's platform key, else Gemini's,
 *                 both billed to the platform; else none (null).
 */
export function resolveTranscriber(config: AiConfig): Transcriber | null {
  switch (config.provider) {
    case 'openai':
      return {
        provider: 'openai',
        apiKey: config.apiKey,
        keySource: config.keySource,
        model: aiTranscribeOpenAiModel(),
      };
    case 'gemini':
      return {
        provider: 'gemini',
        apiKey: config.apiKey,
        keySource: config.keySource,
        model: config.model,
      };
    case 'anthropic': {
      const openai = platformApiKey('openai');
      if (openai) {
        return {
          provider: 'openai',
          apiKey: openai,
          keySource: 'platform',
          model: aiTranscribeOpenAiModel(),
        };
      }
      const gemini = platformApiKey('gemini');
      if (gemini) {
        return {
          provider: 'gemini',
          apiKey: gemini,
          keySource: 'platform',
          model: AI_PROVIDER_DEFAULT_MODEL.gemini,
        };
      }
      return null;
    }
    default:
      return null;
  }
}
