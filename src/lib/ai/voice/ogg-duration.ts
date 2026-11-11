// ============================================================
// n15.1 (R15) — duration of an Ogg/Opus file without a decoder.
//
// Opus in Ogg always counts granule positions at 48 kHz, so the granule
// of the last page divided by 48 000 is the length in seconds. Pre-skip
// is not subtracted (< 0.01 s, irrelevant for a size limit).
// ============================================================

const OGG_HEADER_LEN = 27;
const OPUS_RATE = 48_000;

/**
 * Seconds of audio in an Ogg/Opus buffer, or null when it cannot be read
 * (no valid page, granule -1, too short). Scans backwards for the last
 * `OggS` capture pattern with stream structure version 0.
 */
export function oggOpusDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < OGG_HEADER_LEN) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = bytes.byteLength - OGG_HEADER_LEN; i >= 0; i--) {
    if (
      bytes[i] === 0x4f && // O
      bytes[i + 1] === 0x67 && // g
      bytes[i + 2] === 0x67 && // g
      bytes[i + 3] === 0x53 && // S
      bytes[i + 4] === 0
    ) {
      const granule = view.getBigInt64(i + 6, true);
      if (granule < BigInt(0)) return null;
      return Number(granule) / OPUS_RATE;
    }
  }
  return null;
}
