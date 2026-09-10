import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentKeyId,
  decrypt,
  encrypt,
  isCurrentKeyFormat,
  isLegacyFormat,
  keyIdFor,
  keyIdOf,
} from './encryption';

const KEY_HEX = process.env.ENCRYPTION_KEY!;
// A second, distinct key for the rotation scenarios.
const OTHER_KEY_HEX = '11'.repeat(32);

/**
 * CBC fixtures use a derived IV, never `randomBytes`. AES-CBC is
 * unauthenticated: with a random IV, "the wrong key rejects this blob"
 * is only true ~99.6% of the time, which is exactly how you get a suite
 * that fails once every few hundred CI runs. Same inputs, same bytes,
 * same outcome, for ever.
 */
function derivedIv(label: string): Buffer {
  return crypto.createHash('sha256').update(label).digest().subarray(0, 16);
}

function cbcEncryptLegacy(plaintext: string, keyHex = KEY_HEX): string {
  const iv = derivedIv(`${keyHex}|${plaintext}`);
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(keyHex, 'hex'),
    iv
  );
  let ct = cipher.update(plaintext, 'utf8', 'hex');
  ct += cipher.final('hex');
  return `${iv.toString('hex')}:${ct}`;
}

/** Raw AES-256-CBC, PKCS#7 checked but nothing else. Null when the padding is wrong. */
function rawCbcDecrypt(keyHex: string, blob: string): Buffer | null {
  const [ivHex, ctHex] = blob.split(':');
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(keyHex, 'hex'),
      Buffer.from(ivHex, 'hex')
    );
    return Buffer.concat([decipher.update(ctHex, 'hex'), decipher.final()]);
  } catch {
    return null;
  }
}

function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * A real CBC ciphertext of `EAAG-real-token` under OTHER_KEY_HEX whose
 * PKCS#7 padding **also** validates under KEY_HEX. Found by walking
 * `sha256('cbc-legacy#' + n)` IVs until the wrong key cleared the
 * padding (n = 220; it happens about once in 240). Pinned here so the
 * scenario is exercised on every run instead of by luck.
 */
const CBC_PADS_UNDER_WRONG_KEY = {
  plaintext: 'EAAG-real-token',
  blob: '048a6953f595dd302f51f22d2d9fbfb8:7c6d35999417b0233313b7081444042a',
};

/**
 * A CBC blob that decrypts to a well-padded, valid-UTF-8 string under
 * **both** KEY_HEX and OTHER_KEY_HEX. Constructed rather than sampled:
 * for a one-block ciphertext C, plaintext = D_key(C) XOR IV, so a block
 * C whose two raw decryptions differ only in bytes that keep both sides
 * inside ASCII (and agree on the last byte, the padding length) gives a
 * choice of IV that satisfies both keys at once. Roughly one block in
 * 8 million qualifies; this is the first one under
 * `sha256('cbc-ring-collision#' + n)`.
 */
const CBC_DECRYPTS_UNDER_BOTH_KEYS = {
  blob: 'ce10235d7099c950412a3dda29fea063:65c00f5dbc5d72f9ff3699c1f30aa1e5',
  underCurrentKey: 'aaaaaaaaa0aa0a0',
  underPreviousKey: 'Pg$%z`&&K^|kW4N',
};

/** The pre-rotation GCM shape: no key id prefix. */
function gcmEncryptUnversioned(plaintext: string, keyHex = KEY_HEX): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(keyHex, 'hex'),
    iv
  );
  let ct = cipher.update(plaintext, 'utf8', 'hex');
  ct += cipher.final('hex');
  return `${iv.toString('hex')}:${ct}:${cipher.getAuthTag().toString('hex')}`;
}

/** Encrypt under an arbitrary key by temporarily making it the current one. */
function encryptWithKey(plaintext: string, keyHex: string): string {
  const saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = keyHex;
  try {
    return encrypt(plaintext);
  } finally {
    process.env.ENCRYPTION_KEY = saved;
  }
}

afterEach(() => {
  process.env.ENCRYPTION_KEY = KEY_HEX;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
});

describe('encryption', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('recovers the original plaintext', () => {
      const ct = encrypt('EAAG... fake WhatsApp token');
      expect(decrypt(ct)).toBe('EAAG... fake WhatsApp token');
    });

    it('produces a key id plus three colon-separated GCM parts', () => {
      const ct = encrypt('anything');
      const parts = ct.split(':');
      expect(parts).toHaveLength(4);
      expect(parts[0]).toMatch(/^k[0-9a-f]{8}$/);
      expect(parts[0]).toBe(currentKeyId());
    });

    it('uses a fresh IV per encrypt so identical plaintexts produce different ciphertexts', () => {
      const a = encrypt('same input');
      const b = encrypt('same input');
      expect(a).not.toBe(b);
      expect(decrypt(a)).toBe('same input');
      expect(decrypt(b)).toBe('same input');
    });

    it('roundtrips empty string', () => {
      const ct = encrypt('');
      expect(decrypt(ct)).toBe('');
    });

    it('roundtrips multibyte UTF-8', () => {
      const ct = encrypt('token-✓-🔐-žąsis');
      expect(decrypt(ct)).toBe('token-✓-🔐-žąsis');
    });

    // A secret pasted from a BOM'd file must come back byte for byte:
    // WHATWG decoding eats a leading U+FEFF unless `ignoreBOM` is set,
    // and `encrypt(decrypt(stored))` would persist the truncation.
    it('roundtrips a leading U+FEFF instead of swallowing it', () => {
      expect(decrypt(encrypt('\uFEFFsecret'))).toBe('\uFEFFsecret');
      // A U+FEFF anywhere else was never at risk; pin it anyway.
      expect(decrypt(encrypt('sec\uFEFFret'))).toBe('sec\uFEFFret');
    });

    it('keeps a leading U+FEFF on a legacy CBC blob read through the key ring', () => {
      const cbcOld = cbcEncryptLegacy('\uFEFFsecret', OTHER_KEY_HEX);
      process.env.ENCRYPTION_KEY_PREVIOUS = OTHER_KEY_HEX;
      expect(decrypt(cbcOld)).toBe('\uFEFFsecret');
    });
  });

  describe('GCM authentication', () => {
    it('rejects ciphertext tampered after encryption', () => {
      const ct = encrypt('secret');
      const [keyId, ivHex, ctHex, tagHex] = ct.split(':');
      // Flip a byte in the ciphertext body — auth tag will mismatch.
      const tamperedCtHex =
        (parseInt(ctHex.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0') +
        ctHex.slice(2);
      expect(() =>
        decrypt(`${keyId}:${ivHex}:${tamperedCtHex}:${tagHex}`)
      ).toThrow();
    });

    it('rejects a swapped auth tag', () => {
      const ct = encrypt('secret');
      const [keyId, ivHex, ctHex] = ct.split(':');
      const bogusTag = '00'.repeat(16);
      expect(() => decrypt(`${keyId}:${ivHex}:${ctHex}:${bogusTag}`)).toThrow();
    });

    it('rejects a GCM IV of the wrong length', () => {
      const ct = encrypt('secret');
      const [keyId, , ctHex, tagHex] = ct.split(':');
      const shortIv = '00'.repeat(8); // 8 bytes ≠ 12
      expect(() => decrypt(`${keyId}:${shortIv}:${ctHex}:${tagHex}`)).toThrow(
        /GCM IV length/
      );
    });

    it('rejects a GCM auth tag of the wrong length', () => {
      const ct = encrypt('secret');
      const [keyId, ivHex, ctHex] = ct.split(':');
      const shortTag = '00'.repeat(8); // 8 bytes ≠ 16
      expect(() => decrypt(`${keyId}:${ivHex}:${ctHex}:${shortTag}`)).toThrow(
        /auth-tag length/
      );
    });
  });

  describe('legacy formats without a key id (read-only)', () => {
    it('decrypts an unversioned GCM blob produced before key ids existed', () => {
      const legacy = gcmEncryptUnversioned('old-gcm-token');
      expect(decrypt(legacy)).toBe('old-gcm-token');
    });

    it('decrypts a CBC blob produced by the original codepath', () => {
      const legacy = cbcEncryptLegacy('old-token');
      expect(decrypt(legacy)).toBe('old-token');
    });

    it('rejects a CBC blob with the wrong IV length', () => {
      // 8-byte IV (16 hex chars) instead of 16 bytes.
      const bogus = '00'.repeat(8) + ':' + '00'.repeat(16);
      expect(() => decrypt(bogus)).toThrow(/CBC IV length/);
    });
  });

  describe('key rotation', () => {
    // Criterion: with two keys configured, ciphertexts under either decrypt.
    it('decrypts versioned ciphertexts written under the current OR the previous key', () => {
      const underOld = encryptWithKey('written-before-rotation', OTHER_KEY_HEX);
      const underNew = encrypt('written-after-rotation');

      process.env.ENCRYPTION_KEY_PREVIOUS = OTHER_KEY_HEX;
      expect(decrypt(underNew)).toBe('written-after-rotation');
      expect(decrypt(underOld)).toBe('written-before-rotation');
    });

    // Criterion: new values are always written with the current key.
    it('encrypt() always uses the current key, never a previous one', () => {
      process.env.ENCRYPTION_KEY_PREVIOUS = OTHER_KEY_HEX;
      const ct = encrypt('fresh');
      expect(keyIdOf(ct)).toBe(keyIdFor(KEY_HEX));
      expect(keyIdOf(ct)).not.toBe(keyIdFor(OTHER_KEY_HEX));
      // …and the current key alone is enough to read it back.
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      expect(decrypt(ct)).toBe('fresh');
    });

    // Criterion: unprefixed legacy values still decrypt — with either key.
    it('tries every key in the ring for unprefixed GCM and CBC blobs', () => {
      const gcmOld = gcmEncryptUnversioned('gcm-under-old-key', OTHER_KEY_HEX);
      const cbcOld = cbcEncryptLegacy('cbc-under-old-key', OTHER_KEY_HEX);
      const gcmCurrent = gcmEncryptUnversioned('gcm-under-current-key');

      // Without the old key in the ring these are unreadable…
      expect(() => decrypt(gcmOld)).toThrow();
      expect(() => decrypt(cbcOld)).toThrow();

      // …and readable once it is listed as previous.
      process.env.ENCRYPTION_KEY_PREVIOUS = OTHER_KEY_HEX;
      expect(decrypt(gcmOld)).toBe('gcm-under-old-key');
      expect(decrypt(cbcOld)).toBe('cbc-under-old-key');
      expect(decrypt(gcmCurrent)).toBe('gcm-under-current-key');
    });

    // Regression: the ring made a wrong-key CBC "success" possible, and
    // the write-backs would have stored encrypt(garbage) over the token.
    it('returns the retired key\u2019s plaintext, not the garbage the current key happens to unpad', () => {
      const { plaintext, blob } = CBC_PADS_UNDER_WRONG_KEY;

      // Pin the fixture: the current key really does clear PKCS#7 here…
      const wrongKeyBytes = rawCbcDecrypt(KEY_HEX, blob);
      expect(wrongKeyBytes).not.toBeNull();
      // …and only the UTF-8 check tells those bytes from a real secret.
      expect(isValidUtf8(wrongKeyBytes!)).toBe(false);
      expect(rawCbcDecrypt(OTHER_KEY_HEX, blob)!.toString('utf8')).toBe(
        plaintext
      );

      process.env.ENCRYPTION_KEY_PREVIOUS = OTHER_KEY_HEX;
      expect(decrypt(blob)).toBe(plaintext);
    });

    it('refuses to pick a plaintext when two keys in the ring both succeed', () => {
      const { blob, underCurrentKey, underPreviousKey } =
        CBC_DECRYPTS_UNDER_BOTH_KEYS;

      // Pin the fixture: both keys yield well-padded, valid UTF-8.
      expect(rawCbcDecrypt(KEY_HEX, blob)!.toString('utf8')).toBe(
        underCurrentKey
      );
      expect(rawCbcDecrypt(OTHER_KEY_HEX, blob)!.toString('utf8')).toBe(
        underPreviousKey
      );

      // Known limit: with a single key there is nothing to compare
      // against, so an unauthenticated CBC blob is taken at face value.
      expect(decrypt(blob)).toBe(underCurrentKey);

      // With the retired key in the ring the collision is visible, and
      // guessing is exactly what corrupts a token: fail closed.
      process.env.ENCRYPTION_KEY_PREVIOUS = OTHER_KEY_HEX;
      expect(() => decrypt(blob)).toThrow(/more than one configured key/);
      expect(() => decrypt(blob)).toThrow(
        new RegExp(`${keyIdFor(KEY_HEX)}, ${keyIdFor(OTHER_KEY_HEX)}`)
      );
    });

    it('treats non-UTF-8 plaintext as \u201cnot this key\u201d, never as a result', () => {
      const [ivHex, ctHex] = CBC_PADS_UNDER_WRONG_KEY.blob.split(':');
      // Only the wrong key in the ring: the blob is unreadable, and the
      // caller gets an error instead of mojibake it would re-encrypt.
      expect(() => decrypt(`${ivHex}:${ctHex}`)).toThrow(/UTF-8/);
    });

    it('names the missing key when a versioned blob points outside the ring', () => {
      const underOld = encryptWithKey('orphan', OTHER_KEY_HEX);
      expect(() => decrypt(underOld)).toThrow(
        new RegExp(`${keyIdFor(OTHER_KEY_HEX)}.*ENCRYPTION_KEY_PREVIOUS`)
      );
    });

    it('accepts several previous keys, comma-separated, and ignores blanks', () => {
      const third = '22'.repeat(32);
      const underThird = encryptWithKey('third', third);
      process.env.ENCRYPTION_KEY_PREVIOUS = ` ${OTHER_KEY_HEX}, ,${third},`;
      expect(decrypt(underThird)).toBe('third');
    });

    it('derives the key id from the key itself, not from configuration', () => {
      expect(keyIdFor(KEY_HEX)).toBe(keyIdFor(KEY_HEX));
      expect(keyIdFor(KEY_HEX)).not.toBe(keyIdFor(OTHER_KEY_HEX));
      expect(keyIdFor(KEY_HEX)).toMatch(/^k[0-9a-f]{8}$/);
    });

    it('rejects a malformed key with a clear message', () => {
      process.env.ENCRYPTION_KEY = 'not-hex';
      expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY must be 32 bytes/);
      process.env.ENCRYPTION_KEY = KEY_HEX;
      process.env.ENCRYPTION_KEY_PREVIOUS = 'abcd';
      expect(() => decrypt(encrypt('x'))).toThrow(/32 bytes/);
    });
  });

  describe('format detection', () => {
    it('isLegacyFormat is true for CBC, unversioned GCM and retired-key blobs', () => {
      expect(isLegacyFormat(cbcEncryptLegacy('anything'))).toBe(true);
      expect(isLegacyFormat(gcmEncryptUnversioned('anything'))).toBe(true);
      process.env.ENCRYPTION_KEY_PREVIOUS = OTHER_KEY_HEX;
      expect(isLegacyFormat(encryptWithKey('anything', OTHER_KEY_HEX))).toBe(
        true
      );
    });

    it('isLegacyFormat is false only for blobs under the current key', () => {
      const modern = encrypt('anything');
      expect(isLegacyFormat(modern)).toBe(false);
      expect(isCurrentKeyFormat(modern)).toBe(true);
    });

    it('keyIdOf returns the prefix, or null for unprefixed blobs', () => {
      expect(keyIdOf(encrypt('x'))).toBe(currentKeyId());
      expect(keyIdOf(gcmEncryptUnversioned('x'))).toBeNull();
      expect(keyIdOf(cbcEncryptLegacy('x'))).toBeNull();
    });
  });

  describe('malformed input', () => {
    it('throws on a single-token blob (no colons)', () => {
      expect(() => decrypt('not-encrypted-at-all')).toThrow(
        /unrecognised format/
      );
    });

    it('throws on a four-part blob whose first part is not a key id', () => {
      expect(() => decrypt('aa:bb:cc:dd')).toThrow(/unrecognised format/);
    });

    it('throws on a five-part blob', () => {
      expect(() => decrypt('k00000000:aa:bb:cc:dd')).toThrow(
        /unrecognised format/
      );
    });
  });
});
