// ============================================================
// n15.1 — tunables and pure helpers for voice-note transcription.
// Same env-reading pattern as `aiRequestTimeoutMs` (../defaults.ts): a
// finite number > 0, otherwise the default.
// ============================================================

/** Prefix a transcribed voice note carries as a `user` turn (R25). */
export const VOICE_NOTE_MARKER = '[nota de voz]';

/** Mirrors the `messages_transcript_len` CHECK of migration 096. */
export const TRANSCRIPT_MAX_CHARS = 4000;

/** R19: fixed wait before the single retry of a transient failure. */
export const TRANSCRIBE_RETRY_DELAY_MS = 1_000;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_FALLBACK_COOLDOWN_MINUTES = 10;

function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Largest audio we download/transcribe. `AI_VOICE_MAX_BYTES`, 5 MiB. */
export function aiVoiceMaxBytes(): number {
  return Math.floor(positiveEnv('AI_VOICE_MAX_BYTES', DEFAULT_MAX_BYTES));
}

/** Longest Ogg/Opus voice note we transcribe. `AI_VOICE_MAX_SECONDS`, 300. */
export function aiVoiceMaxSeconds(): number {
  return positiveEnv('AI_VOICE_MAX_SECONDS', DEFAULT_MAX_SECONDS);
}

/** Per-attempt transcription timeout. `AI_TRANSCRIBE_TIMEOUT_MS`, 15 s. */
export function aiTranscribeTimeoutMs(): number {
  return positiveEnv('AI_TRANSCRIBE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

/** OpenAI transcription model. `AI_TRANSCRIBE_OPENAI_MODEL`. */
export function aiTranscribeOpenAiModel(): string {
  const raw = process.env.AI_TRANSCRIBE_OPENAI_MODEL;
  const model = typeof raw === 'string' ? raw.trim() : '';
  return model || DEFAULT_OPENAI_MODEL;
}

/** At most one fallback text per conversation in this window (D3).
 *  `AI_VOICE_FALLBACK_COOLDOWN_MINUTES`, 10 min; returned in ms. */
export function aiVoiceFallbackCooldownMs(): number {
  return (
    positiveEnv(
      'AI_VOICE_FALLBACK_COOLDOWN_MINUTES',
      DEFAULT_FALLBACK_COOLDOWN_MINUTES
    ) *
    60 *
    1000
  );
}

/** Collapse whitespace, trim, and cut to `TRANSCRIPT_MAX_CHARS` (R20). */
export function cleanTranscript(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > TRANSCRIPT_MAX_CHARS
    ? collapsed.slice(0, TRANSCRIPT_MAX_CHARS).trimEnd()
    : collapsed;
}

/** The `user` turn content for a transcribed voice note (R25). */
export function formatVoiceNote(text: string): string {
  return `${VOICE_NOTE_MARKER} ${text}`;
}

/**
 * The turn's context with this voice note's transcript in it (R22): when
 * the transcript UPDATE failed, the context read from the database lacks
 * it, and the turn must still answer what the customer said. Appends it
 * as the latest `user` turn unless the context's LAST turn already is
 * this same voice note. Only the last one counts: an older voice turn
 * with the same text («sí») is a previous note, not this one. Pure;
 * returns a new array.
 */
export function withVoiceTurn<
  T extends { role: string; content: string; voice?: boolean },
>(
  messages: T[],
  transcript: string
): (T | { role: 'user'; content: string; voice: true })[] {
  const content = formatVoiceNote(transcript);
  const last = messages[messages.length - 1];
  if (last && last.voice && last.content === content) {
    return [...messages];
  }
  return [...messages, { role: 'user', content, voice: true }];
}

/** Inverse of `formatVoiceNote`: the transcript without the marker (R27). */
export function stripVoiceNoteMarker(content: string): string {
  return content.startsWith(VOICE_NOTE_MARKER)
    ? content.slice(VOICE_NOTE_MARKER.length).trimStart()
    : content;
}
