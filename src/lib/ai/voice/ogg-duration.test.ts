import { describe, expect, it } from 'vitest';
import { oggOpusDurationSeconds } from './ogg-duration';

/** A minimal Ogg page: 27-byte header + one segment of `payload` bytes. */
function oggPage(granule: bigint, payload = 4): Uint8Array {
  const page = new Uint8Array(27 + 1 + payload);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  page[4] = 0; // version
  new DataView(page.buffer).setBigInt64(6, granule, true);
  page[26] = 1; // one segment
  page[27] = payload;
  return page;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

describe('oggOpusDurationSeconds (R15)', () => {
  it('reads the granule of the last page of a 3-page stream', () => {
    const bytes = concat(
      oggPage(BigInt(0)),
      oggPage(BigInt(0)),
      oggPage(BigInt(48000 * 12))
    );
    expect(oggOpusDurationSeconds(bytes)).toBe(12);
  });

  it('returns null for a granule of -1', () => {
    expect(oggOpusDurationSeconds(oggPage(BigInt(-1)))).toBeNull();
  });

  it('returns null when there is no OggS page', () => {
    expect(oggOpusDurationSeconds(new Uint8Array(200))).toBeNull();
  });

  it('returns null for a 10-byte buffer', () => {
    expect(oggOpusDurationSeconds(new Uint8Array(10))).toBeNull();
  });

  it('works on a subarray view (non-zero byteOffset)', () => {
    const bytes = concat(new Uint8Array(13), oggPage(BigInt(48000 * 3)));
    expect(oggOpusDurationSeconds(bytes.subarray(13))).toBe(3);
  });
});
