import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiTranscribeOpenAiModel,
  aiTranscribeTimeoutMs,
  aiVoiceFallbackCooldownMs,
  aiVoiceMaxBytes,
  aiVoiceMaxSeconds,
  cleanTranscript,
  formatVoiceNote,
  stripVoiceNoteMarker,
  TRANSCRIBE_RETRY_DELAY_MS,
  TRANSCRIPT_MAX_CHARS,
  VOICE_NOTE_MARKER,
} from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('voice config defaults (D5)', () => {
  it('uses 5 MiB, 300 s, 15 s, gpt-4o-mini-transcribe and a 10 min cooldown', () => {
    for (const name of [
      'AI_VOICE_MAX_BYTES',
      'AI_VOICE_MAX_SECONDS',
      'AI_TRANSCRIBE_TIMEOUT_MS',
      'AI_TRANSCRIBE_OPENAI_MODEL',
      'AI_VOICE_FALLBACK_COOLDOWN_MINUTES',
    ]) {
      vi.stubEnv(name, '');
    }
    expect(aiVoiceMaxBytes()).toBe(5 * 1024 * 1024);
    expect(aiVoiceMaxSeconds()).toBe(300);
    expect(aiTranscribeTimeoutMs()).toBe(15_000);
    expect(aiTranscribeOpenAiModel()).toBe('gpt-4o-mini-transcribe');
    expect(aiVoiceFallbackCooldownMs()).toBe(10 * 60 * 1000);
    expect(TRANSCRIBE_RETRY_DELAY_MS).toBe(1000);
  });

  it('reads valid overrides from the environment', () => {
    vi.stubEnv('AI_VOICE_MAX_BYTES', '1024');
    vi.stubEnv('AI_VOICE_MAX_SECONDS', '60');
    vi.stubEnv('AI_TRANSCRIBE_TIMEOUT_MS', '5000');
    vi.stubEnv('AI_TRANSCRIBE_OPENAI_MODEL', ' whisper-1 ');
    vi.stubEnv('AI_VOICE_FALLBACK_COOLDOWN_MINUTES', '2');
    expect(aiVoiceMaxBytes()).toBe(1024);
    expect(aiVoiceMaxSeconds()).toBe(60);
    expect(aiTranscribeTimeoutMs()).toBe(5000);
    expect(aiTranscribeOpenAiModel()).toBe('whisper-1');
    expect(aiVoiceFallbackCooldownMs()).toBe(2 * 60 * 1000);
  });

  it('falls back to the defaults on invalid values', () => {
    vi.stubEnv('AI_VOICE_MAX_BYTES', 'lots');
    vi.stubEnv('AI_VOICE_MAX_SECONDS', '-1');
    vi.stubEnv('AI_TRANSCRIBE_TIMEOUT_MS', '0');
    vi.stubEnv('AI_TRANSCRIBE_OPENAI_MODEL', '   ');
    vi.stubEnv('AI_VOICE_FALLBACK_COOLDOWN_MINUTES', 'nope');
    expect(aiVoiceMaxBytes()).toBe(5 * 1024 * 1024);
    expect(aiVoiceMaxSeconds()).toBe(300);
    expect(aiTranscribeTimeoutMs()).toBe(15_000);
    expect(aiTranscribeOpenAiModel()).toBe('gpt-4o-mini-transcribe');
    expect(aiVoiceFallbackCooldownMs()).toBe(10 * 60 * 1000);
  });
});

describe('cleanTranscript (R20)', () => {
  it('collapses whitespace and trims', () => {
    expect(cleanTranscript('  hola \n\n  qué   tal\t ')).toBe('hola qué tal');
  });

  it('cuts to 4000 characters', () => {
    const out = cleanTranscript('a'.repeat(5000));
    expect(out).toHaveLength(TRANSCRIPT_MAX_CHARS);
  });

  it('returns empty for blank input', () => {
    expect(cleanTranscript(' \n\t ')).toBe('');
  });
});

describe('formatVoiceNote / stripVoiceNoteMarker', () => {
  it('prefixes the marker and strips it back', () => {
    const formatted = formatVoiceNote('tienen cita');
    expect(formatted).toBe(`${VOICE_NOTE_MARKER} tienen cita`);
    expect(VOICE_NOTE_MARKER).toBe('[nota de voz]');
    expect(stripVoiceNoteMarker(formatted)).toBe('tienen cita');
    expect(stripVoiceNoteMarker('sin marca')).toBe('sin marca');
  });
});
