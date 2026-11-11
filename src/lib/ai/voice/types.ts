import type { AiKeySource } from '../types';

// ============================================================
// n15.1 — voice notes for the AI auto-reply.
// ============================================================

/** What the webhook knows about an inbound voice note that the stored
 *  row does not: Meta's media id and the token to fetch it with. Never
 *  persisted, never logged. */
export interface VoiceNoteSource {
  metaMediaId: string;
  accessToken: string;
}

/** Domain of `messages.transcript_status` (migration 096). */
export type TranscriptStatus = 'done' | 'failed' | 'skipped';

/** Why a voice note has no transcript. Only reaches logs. */
export type VoiceFailureReason =
  // skipped
  | 'no_transcriber'
  | 'too_large'
  | 'too_long'
  | 'unsupported_format'
  // failed
  | 'forbidden_path'
  | 'download_failed'
  | 'timeout'
  | 'network_error'
  | 'invalid_key'
  | 'rate_limited'
  | 'provider_error'
  | 'empty'
  | 'previous_attempt';

export type TranscriptOutcome =
  | { status: 'done'; text: string }
  | { status: 'failed' | 'skipped'; reason: VoiceFailureReason };

/** The (provider, key, model) that turns the audio into text. */
export interface Transcriber {
  provider: 'openai' | 'gemini';
  apiKey: string;
  /** Who pays: rides to `ai_usage_log.key_source` (R23). */
  keySource: AiKeySource;
  model: string;
}
