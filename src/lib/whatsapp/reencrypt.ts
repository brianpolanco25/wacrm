import { decrypt, encrypt, isLegacyFormat } from './encryption.ts';

/**
 * Re-encryption of stored secrets after a key rotation.
 *
 * The CLI in `scripts/reencrypt-secrets.ts` is a thin wrapper around
 * this module so the batching / skip / dry-run logic is unit-tested
 * against a fake client rather than only exercised against production.
 *
 * Relative imports carry their `.ts` extension on purpose: Node 24 runs
 * this file directly (type stripping, no bundler) and resolves relative
 * specifiers literally.
 */

/** Every column that holds an `encrypt()` output. Keep in sync with the schema. */
export const ENCRYPTED_COLUMNS: ReadonlyArray<EncryptedTarget> = [
  { table: 'whatsapp_config', columns: ['access_token', 'verify_token'] },
  { table: 'ai_configs', columns: ['api_key', 'embeddings_api_key'] },
  { table: 'webhook_endpoints', columns: ['secret'] },
];

export interface EncryptedTarget {
  table: string;
  columns: string[];
}

/** The slice of a Supabase client the re-encryption needs. Narrow so tests can fake it. */
export interface ReencryptDb {
  from(table: string): {
    select(columns: string): {
      order(
        column: string,
        opts: { ascending: boolean }
      ): {
        range(
          from: number,
          to: number
        ): PromiseLike<{
          data: Record<string, unknown>[] | null;
          error: { message: string } | null;
        }>;
      };
    };
    update(values: Record<string, unknown>): {
      eq(
        column: string,
        value: unknown
      ): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

export interface ReencryptOptions {
  /** Report what would change without writing. */
  dryRun: boolean;
  /** Rows per page. */
  batchSize: number;
  log?: (line: string) => void;
}

export interface ReencryptStats {
  table: string;
  /** Rows read. */
  scanned: number;
  /** Rows that had at least one column rewritten (or would have, in dry-run). */
  rewritten: number;
  /** Rows already under the current key in every column. */
  skipped: number;
  /** Rows with a column that could not be decrypted — left untouched. */
  failed: number;
}

/**
 * Compute the new ciphertext for one stored value, or null when it is
 * already under the current key (nothing to do). Throws when the value
 * cannot be decrypted with any configured key — the caller must leave
 * the row alone rather than write garbage.
 */
export function reencryptValue(stored: string): string | null {
  if (!isLegacyFormat(stored)) return null;
  return encrypt(decrypt(stored));
}

/**
 * Walk one table in id order, page by page, rewriting every encrypted
 * column that is not yet under the current key. Never throws for a bad
 * row: the failure is counted, logged and the row is skipped so one
 * corrupt token can't stall the rest of the rotation.
 */
export async function reencryptTable(
  db: ReencryptDb,
  target: EncryptedTarget,
  opts: ReencryptOptions
): Promise<ReencryptStats> {
  const log = opts.log ?? (() => {});
  const stats: ReencryptStats = {
    table: target.table,
    scanned: 0,
    rewritten: 0,
    skipped: 0,
    failed: 0,
  };
  const columns = ['id', ...target.columns].join(', ');

  for (let offset = 0; ; offset += opts.batchSize) {
    const { data, error } = await db
      .from(target.table)
      .select(columns)
      .order('id', { ascending: true })
      .range(offset, offset + opts.batchSize - 1);
    if (error) throw new Error(`${target.table}: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      stats.scanned += 1;
      const update: Record<string, string> = {};
      let rowFailed = false;

      for (const column of target.columns) {
        const stored = row[column];
        if (typeof stored !== 'string' || stored.length === 0) continue;
        try {
          const next = reencryptValue(stored);
          if (next) update[column] = next;
        } catch (err) {
          rowFailed = true;
          log(
            `${target.table}.${column} id=${String(row.id)}: cannot decrypt — ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      if (rowFailed) {
        stats.failed += 1;
        continue;
      }
      if (Object.keys(update).length === 0) {
        stats.skipped += 1;
        continue;
      }

      if (opts.dryRun) {
        log(
          `${target.table} id=${String(row.id)}: would rewrite ${Object.keys(update).join(', ')}`
        );
        stats.rewritten += 1;
        continue;
      }

      const { error: updErr } = await db
        .from(target.table)
        .update(update)
        .eq('id', row.id);
      if (updErr) {
        stats.failed += 1;
        log(
          `${target.table} id=${String(row.id)}: update failed — ${updErr.message}`
        );
        continue;
      }
      stats.rewritten += 1;
    }

    if (data.length < opts.batchSize) break;
  }

  return stats;
}

/** Run {@link reencryptTable} over every known encrypted column. */
export async function reencryptAll(
  db: ReencryptDb,
  opts: ReencryptOptions,
  targets: ReadonlyArray<EncryptedTarget> = ENCRYPTED_COLUMNS
): Promise<ReencryptStats[]> {
  const out: ReencryptStats[] = [];
  for (const target of targets) {
    out.push(await reencryptTable(db, target, opts));
  }
  return out;
}
