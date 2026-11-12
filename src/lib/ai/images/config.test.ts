import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiImageDownloadTimeoutMs,
  aiImageMaxBytes,
  aiImageMaxPerTurn,
  formatImageTurn,
  IMAGE_MARKER,
  IMAGE_UNAVAILABLE_MARKER,
  PLAYGROUND_IMAGE_MAX_BYTES,
  stripImageMarker,
} from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('image config (R10)', () => {
  it('defaults to 3 images, 3 932 160 bytes and 8 s', () => {
    for (const name of [
      'AI_IMAGE_MAX_PER_TURN',
      'AI_IMAGE_MAX_BYTES',
      'AI_IMAGE_DOWNLOAD_TIMEOUT_MS',
    ]) {
      vi.stubEnv(name, '');
    }
    expect(aiImageMaxPerTurn()).toBe(3);
    expect(aiImageMaxBytes()).toBe(3_932_160);
    expect(aiImageDownloadTimeoutMs()).toBe(8000);
    expect(PLAYGROUND_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('AI_IMAGE_MAX_PER_TURN=0 turns vision off', () => {
    vi.stubEnv('AI_IMAGE_MAX_PER_TURN', '0');
    expect(aiImageMaxPerTurn()).toBe(0);
  });

  it('AI_IMAGE_MAX_PER_TURN accepts a valid integer', () => {
    vi.stubEnv('AI_IMAGE_MAX_PER_TURN', '5');
    expect(aiImageMaxPerTurn()).toBe(5);
  });

  it('AI_IMAGE_MAX_PER_TURN invalid → 3', () => {
    for (const raw of ['-1', 'abc', '1.5']) {
      vi.stubEnv('AI_IMAGE_MAX_PER_TURN', raw);
      expect(aiImageMaxPerTurn()).toBe(3);
    }
  });

  it('reads valid byte and timeout overrides', () => {
    vi.stubEnv('AI_IMAGE_MAX_BYTES', '1000');
    vi.stubEnv('AI_IMAGE_DOWNLOAD_TIMEOUT_MS', '2500');
    expect(aiImageMaxBytes()).toBe(1000);
    expect(aiImageDownloadTimeoutMs()).toBe(2500);
  });

  it('falls back on invalid byte and timeout values', () => {
    for (const raw of ['0', '-5', 'x']) {
      vi.stubEnv('AI_IMAGE_MAX_BYTES', raw);
      vi.stubEnv('AI_IMAGE_DOWNLOAD_TIMEOUT_MS', raw);
      expect(aiImageMaxBytes()).toBe(3_932_160);
      expect(aiImageDownloadTimeoutMs()).toBe(8000);
    }
  });
});

describe('formatImageTurn / stripImageMarker', () => {
  it('formats the four combinations', () => {
    expect(formatImageTurn(null, true)).toBe('[imagen]');
    expect(formatImageTurn('mi cédula', true)).toBe('[imagen] mi cédula');
    expect(formatImageTurn(null, false)).toBe('[imagen no disponible]');
    expect(formatImageTurn('  mi cédula ', false)).toBe(
      '[imagen no disponible] mi cédula'
    );
    expect(formatImageTurn('   ', true)).toBe(IMAGE_MARKER);
  });

  it('strips either marker, and leaves unmarked text alone', () => {
    expect(stripImageMarker('[imagen] hola')).toBe('hola');
    expect(stripImageMarker(IMAGE_MARKER)).toBe('');
    expect(stripImageMarker('[imagen no disponible] hola')).toBe('hola');
    expect(stripImageMarker(IMAGE_UNAVAILABLE_MARKER)).toBe('');
    expect(stripImageMarker('hola')).toBe('hola');
  });
});
