import { afterEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt, keyIdOf, currentKeyId } from './encryption';
import {
  ENCRYPTED_COLUMNS,
  reencryptAll,
  reencryptTable,
  reencryptValue,
  type ReencryptDb,
} from './reencrypt';

const KEY_HEX = process.env.ENCRYPTION_KEY!;
const OLD_KEY_HEX = '11'.repeat(32);

function encryptWithKey(plaintext: string, keyHex: string): string {
  const saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = keyHex;
  try {
    return encrypt(plaintext);
  } finally {
    process.env.ENCRYPTION_KEY = saved;
  }
}

/**
 * In-memory stand-in for the two query shapes the script uses:
 * `select().order().range()` for paging and `update().eq()` for the
 * write-back. Records every update so the tests can assert what was
 * (not) written.
 */
function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  const updates: {
    table: string;
    id: unknown;
    values: Record<string, unknown>;
  }[] = [];
  const db: ReencryptDb = {
    from(table) {
      const rows = tables[table] ?? [];
      return {
        select: () => ({
          order: () => ({
            range: (from: number, to: number) =>
              Promise.resolve({
                data: [...rows]
                  .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                  .slice(from, to + 1),
                error: null,
              }),
          }),
        }),
        update: (values) => ({
          eq: (_column: string, id: unknown) => {
            updates.push({ table, id, values });
            const row = rows.find((r) => r.id === id);
            if (row) Object.assign(row, values);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
  return { db, updates };
}

afterEach(() => {
  process.env.ENCRYPTION_KEY = KEY_HEX;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
});

describe('reencryptValue', () => {
  it('returns null for a value already under the current key', () => {
    expect(reencryptValue(encrypt('fresh'))).toBeNull();
  });

  it('rewrites a value under a retired key with the current one', () => {
    process.env.ENCRYPTION_KEY_PREVIOUS = OLD_KEY_HEX;
    const old = encryptWithKey('rotate-me', OLD_KEY_HEX);
    const next = reencryptValue(old);
    expect(next).not.toBeNull();
    expect(keyIdOf(next!)).toBe(currentKeyId());
    expect(decrypt(next!)).toBe('rotate-me');
  });

  it('throws (rather than writing garbage) when no key can decrypt the value', () => {
    const orphan = encryptWithKey('lost', OLD_KEY_HEX);
    expect(() => reencryptValue(orphan)).toThrow();
  });
});

describe('reencryptTable', () => {
  it('rewrites only the columns that need it, in batches, and skips current rows', async () => {
    process.env.ENCRYPTION_KEY_PREVIOUS = OLD_KEY_HEX;
    const { db, updates } = fakeDb({
      whatsapp_config: [
        {
          id: 'a',
          access_token: encryptWithKey('tok-a', OLD_KEY_HEX),
          verify_token: encrypt('verify-a'), // already current
        },
        { id: 'b', access_token: encrypt('tok-b'), verify_token: null },
        {
          id: 'c',
          access_token: encryptWithKey('tok-c', OLD_KEY_HEX),
          verify_token: '',
        },
      ],
    });

    const stats = await reencryptTable(db, ENCRYPTED_COLUMNS[0], {
      dryRun: false,
      batchSize: 2, // forces two pages
    });

    expect(stats).toEqual({
      table: 'whatsapp_config',
      scanned: 3,
      rewritten: 2,
      skipped: 1,
      failed: 0,
    });
    expect(updates.map((u) => u.id)).toEqual(['a', 'c']);
    // Only the stale column moved; the current one was left alone.
    expect(Object.keys(updates[0].values)).toEqual(['access_token']);
    expect(decrypt(updates[0].values.access_token as string)).toBe('tok-a');
    expect(keyIdOf(updates[0].values.access_token as string)).toBe(
      currentKeyId()
    );
  });

  it('--dry-run reports the rows it would rewrite and writes nothing', async () => {
    process.env.ENCRYPTION_KEY_PREVIOUS = OLD_KEY_HEX;
    const lines: string[] = [];
    const { db, updates } = fakeDb({
      ai_configs: [
        {
          id: 'x',
          api_key: encryptWithKey('sk', OLD_KEY_HEX),
          embeddings_api_key: null,
        },
      ],
    });

    const stats = await reencryptTable(db, ENCRYPTED_COLUMNS[1], {
      dryRun: true,
      batchSize: 50,
      log: (l) => lines.push(l),
    });

    expect(stats.rewritten).toBe(1);
    expect(updates).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/ai_configs id=x: would rewrite api_key/);
  });

  it('counts an undecryptable row as failed and leaves it untouched', async () => {
    const lines: string[] = [];
    const orphan = encryptWithKey('lost', OLD_KEY_HEX); // OLD key NOT in the ring
    const { db, updates } = fakeDb({
      webhook_endpoints: [
        { id: 'w1', secret: orphan },
        { id: 'w2', secret: encrypt('ok') },
      ],
    });

    const stats = await reencryptTable(db, ENCRYPTED_COLUMNS[2], {
      dryRun: false,
      batchSize: 50,
      log: (l) => lines.push(l),
    });

    expect(stats).toMatchObject({
      scanned: 2,
      failed: 1,
      skipped: 1,
      rewritten: 0,
    });
    expect(updates).toHaveLength(0);
    expect(lines[0]).toMatch(/webhook_endpoints\.secret id=w1: cannot decrypt/);
  });
});

describe('reencryptAll', () => {
  it('covers every encrypted column the schema has', () => {
    // If a new encrypted column lands, add it to ENCRYPTED_COLUMNS or the
    // rotation runbook silently leaves it behind.
    expect(ENCRYPTED_COLUMNS).toEqual([
      { table: 'whatsapp_config', columns: ['access_token', 'verify_token'] },
      { table: 'ai_configs', columns: ['api_key', 'embeddings_api_key'] },
      { table: 'webhook_endpoints', columns: ['secret'] },
    ]);
  });

  it('walks every target and returns one stats block per table', async () => {
    const { db } = fakeDb({});
    const stats = await reencryptAll(db, { dryRun: true, batchSize: 10 });
    expect(stats.map((s) => s.table)).toEqual([
      'whatsapp_config',
      'ai_configs',
      'webhook_endpoints',
    ]);
  });
});
