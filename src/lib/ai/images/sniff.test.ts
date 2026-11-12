import { describe, expect, it } from 'vitest';
import { sniffImageMime } from './sniff';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('sniffImageMime (R13)', () => {
  it('detects JPEG, PNG and WebP by magic bytes', () => {
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0))).toBe('image/jpeg');
    expect(
      sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))
    ).toBe('image/png');
    expect(
      sniffImageMime(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBPVP8 ')))
    ).toBe('image/webp');
  });

  it('rejects GIF, PDF, short buffers and RIFF/WAVE', () => {
    expect(sniffImageMime(bytes(...ascii('GIF89a')))).toBeNull();
    expect(sniffImageMime(bytes(...ascii('%PDF-1.7')))).toBeNull();
    expect(sniffImageMime(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffImageMime(bytes())).toBeNull();
    expect(
      sniffImageMime(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVEfmt ')))
    ).toBeNull();
  });
});
