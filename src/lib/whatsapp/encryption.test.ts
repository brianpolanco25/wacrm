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

function cbcEncryptLegacy(plaintext: string, keyHex = KEY_HEX): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(keyHex, 'hex'),
    iv
  );
  let ct = cipher.update(plaintext, 'utf8', 'hex');
  ct += cipher.final('hex');
  return `${iv.toString('hex')}:${ct}`;
}

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
