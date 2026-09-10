import crypto from 'crypto';

/**
 * Secret-at-rest encryption for every credential this app stores:
 * `whatsapp_config.access_token` / `verify_token`, `ai_configs.api_key`
 * / `embeddings_api_key` and `webhook_endpoints.secret`.
 *
 * Format — versioned GCM (current, what `encrypt()` emits):
 *   `k<key-id>:<iv-hex>:<ciphertext-hex>:<authTag-hex>`   (three colons)
 *
 * Format — unversioned GCM (legacy, decrypt-only):
 *   `<iv-hex>:<ciphertext-hex>:<authTag-hex>`             (two colons)
 *
 * Format — CBC (legacy, decrypt-only):
 *   `<iv-hex>:<ciphertext-hex>`                           (one colon)
 *
 * Why GCM instead of CBC:
 *   CBC without a MAC is unauthenticated — an attacker who can write
 *   rows to `whatsapp_config` (directly, through a future RLS bug, or
 *   via a DB backup being modified) can flip bits in the ciphertext
 *   without the decrypt throwing. GCM appends a 16-byte authentication
 *   tag; any tampering fails the decrypt hard.
 *
 * Why a key id prefix (key rotation):
 *   `ENCRYPTION_KEY` is one global key for every tenant's secrets.
 *   Rotating it used to mean every stored secret became undecryptable
 *   at once. The prefix names the key a ciphertext was produced with,
 *   so `decrypt()` can pick the right one from a small key ring:
 *
 *     ENCRYPTION_KEY           — the current key. `encrypt()` always
 *                                uses it.
 *     ENCRYPTION_KEY_PREVIOUS  — zero or more retired keys, comma-
 *                                separated. Decrypt-only.
 *
 *   The id is NOT a counter you have to keep in sync across
 *   environments: it is the first 8 hex chars of SHA-256(key bytes), so
 *   a key identifies itself wherever it is deployed and the ring can
 *   hold any number of retired keys without extra configuration. The
 *   fingerprint reveals nothing usable about the key.
 *
 *   Rotation procedure (see docs/security.md):
 *     1. Move the old value of ENCRYPTION_KEY into ENCRYPTION_KEY_PREVIOUS
 *        and set a fresh 32-byte hex ENCRYPTION_KEY. Restart.
 *     2. Everything new is written under the new key; old rows still
 *        decrypt through the ring.
 *     3. Run `node scripts/reencrypt-secrets.ts` to rewrite old rows.
 *     4. Once nothing is left under the old key, drop it from
 *        ENCRYPTION_KEY_PREVIOUS.
 *
 * Backward compatibility:
 *   Unprefixed ciphertexts carry no key id, so they are tried against
 *   the current key first and then each previous key in order. Call
 *   sites that hold a DB client upgrade rows opportunistically after a
 *   successful decrypt — see `isLegacyFormat` and the `encrypt()` write-
 *   back in `src/lib/whatsapp/send-message.ts`.
 */

// 12 bytes is the NIST-recommended IV length for GCM — keeps the
// counter block well below 2^32 and matches the default web-crypto
// behaviour, so any future port is straightforward.
const GCM_IV_LENGTH = 12;
const CBC_IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_BYTES = 32;

/** `k` + 8 hex chars, e.g. `k3f9a1c2e`. */
const KEY_ID_RE = /^k[0-9a-f]{8}$/;

interface RingKey {
  id: string;
  key: Buffer;
}

interface KeyRing {
  current: RingKey;
  /** Retired keys, most recently retired first. */
  previous: RingKey[];
}

function parseKeyHex(hex: string, source: string): Buffer {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length !== KEY_BYTES * 2) {
    throw new Error(
      `${source} must be ${KEY_BYTES} bytes as ${KEY_BYTES * 2} hex characters`
    );
  }
  return Buffer.from(trimmed, 'hex');
}

function keyIdForBytes(key: Buffer): string {
  return (
    'k' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)
  );
}

/** Stable key identifier: first 8 hex chars of SHA-256 over the key bytes. */
export function keyIdFor(keyHex: string): string {
  return keyIdForBytes(parseKeyHex(keyHex, 'encryption key'));
}

/**
 * Read the key ring from the environment on every call. It is cheap
 * (two env reads + a hash) and it means tests, the re-encryption
 * script and a hot config reload all see the live values without a
 * module-level cache to invalidate.
 */
function keyRing(): KeyRing {
  const currentHex = process.env.ENCRYPTION_KEY;
  if (!currentHex) {
    throw new Error('ENCRYPTION_KEY is not set');
  }
  const currentKey = parseKeyHex(currentHex, 'ENCRYPTION_KEY');
  const current: RingKey = { id: keyIdForBytes(currentKey), key: currentKey };

  const previous: RingKey[] = [];
  const previousRaw = process.env.ENCRYPTION_KEY_PREVIOUS ?? '';
  for (const part of previousRaw.split(',')) {
    const hex = part.trim();
    if (!hex) continue;
    const key = parseKeyHex(hex, 'ENCRYPTION_KEY_PREVIOUS');
    const id = keyIdForBytes(key);
    // The current key listed again as "previous" is harmless but
    // pointless; skip it so the ring has one entry per distinct key.
    if (id === current.id || previous.some((p) => p.id === id)) continue;
    previous.push({ id, key });
  }

  return { current, previous };
}

/** Id of the key `encrypt()` is currently writing with. */
export function currentKeyId(): string {
  return keyRing().current.id;
}

/**
 * Id of the key a ciphertext was produced with, or null for the
 * unprefixed legacy formats (whose key is unknown until decrypt tries).
 */
export function keyIdOf(encryptedText: string): string | null {
  const first = encryptedText.split(':', 1)[0];
  return KEY_ID_RE.test(first) ? first : null;
}

export function encrypt(text: string): string {
  const { current } = keyRing();
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', current.key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${current.id}:${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`;
}

function decryptGcm(
  key: Buffer,
  ivHex: string,
  ctHex: string,
  tagHex: string
): string {
  const iv = Buffer.from(ivHex, 'hex');
  if (iv.length !== GCM_IV_LENGTH) {
    throw new Error(
      `Encrypted token has unexpected GCM IV length ${iv.length}`
    );
  }
  const authTag = Buffer.from(tagHex, 'hex');
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(
      `Encrypted token has unexpected GCM auth-tag length ${authTag.length}`
    );
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ctHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function decryptCbc(key: Buffer, ivHex: string, ctHex: string): string {
  const iv = Buffer.from(ivHex, 'hex');
  if (iv.length !== CBC_IV_LENGTH) {
    throw new Error(
      `Encrypted token has unexpected CBC IV length ${iv.length}`
    );
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(ctHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Try `attempt` with the current key, then each previous key. Structural
 * errors (wrong IV / tag length) are the same for every key and are
 * rethrown immediately; an authentication or padding failure means
 * "not this key" and moves on. The last failure is rethrown when the
 * whole ring is exhausted.
 */
function tryEachKey(ring: KeyRing, attempt: (key: Buffer) => string): string {
  let lastError: unknown = null;
  for (const entry of [ring.current, ...ring.previous]) {
    try {
      return attempt(entry.key);
    } catch (err) {
      if (err instanceof Error && /unexpected (GCM|CBC)/.test(err.message)) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(
        'Encrypted token could not be decrypted with any configured key'
      );
}

export function decrypt(encryptedText: string): string {
  const ring = keyRing();
  const parts = encryptedText.split(':');

  if (parts.length === 4 && KEY_ID_RE.test(parts[0])) {
    // Versioned GCM — current format. The prefix names the key.
    const [keyId, ivHex, ctHex, tagHex] = parts;
    const entry = [ring.current, ...ring.previous].find((k) => k.id === keyId);
    if (!entry) {
      throw new Error(
        `Encrypted token was produced with key ${keyId}, which is not in ENCRYPTION_KEY / ENCRYPTION_KEY_PREVIOUS`
      );
    }
    return decryptGcm(entry.key, ivHex, ctHex, tagHex);
  }

  if (parts.length === 3) {
    // Unversioned GCM — pre-rotation format. Key unknown: try the ring.
    const [ivHex, ctHex, tagHex] = parts;
    return tryEachKey(ring, (key) => decryptGcm(key, ivHex, ctHex, tagHex));
  }

  if (parts.length === 2) {
    // CBC — legacy. Read-only; `encrypt()` never produces this shape.
    const [ivHex, ctHex] = parts;
    return tryEachKey(ring, (key) => decryptCbc(key, ivHex, ctHex));
  }

  throw new Error(
    `Encrypted token has unrecognised format (expected 1-3 colons with a key id, got ${
      parts.length - 1
    })`
  );
}

/**
 * True when a ciphertext should be rewritten with `encrypt()` on the
 * next opportunity: CBC, unversioned GCM, or GCM under a retired key.
 * Call sites that hold a DB client use this to upgrade rows in place
 * after a successful decrypt, which is how a rotation propagates
 * through normal traffic (the re-encryption script covers the rest).
 * Purely structural — never attempts decryption.
 */
export function isLegacyFormat(encryptedText: string): boolean {
  return keyIdOf(encryptedText) !== currentKeyId();
}

/**
 * True when the ciphertext is already in the current format under the
 * current key — the re-encryption script skips these rows.
 */
export function isCurrentKeyFormat(encryptedText: string): boolean {
  return !isLegacyFormat(encryptedText);
}
