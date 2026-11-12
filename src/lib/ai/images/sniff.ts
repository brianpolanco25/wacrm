import type { ChatImage } from '../types';

/**
 * n15.2 (R13): the image format by its magic bytes, never by the row's
 * `media_type` or the download's `Content-Type`. JPEG `FF D8 FF`, PNG
 * `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF????WEBP`; anything else → null.
 */
export function sniffImageMime(
  bytes: Uint8Array
): ChatImage['mimeType'] | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}
