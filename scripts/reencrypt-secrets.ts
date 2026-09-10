#!/usr/bin/env node
/**
 * Re-encrypt every stored secret under the current ENCRYPTION_KEY.
 *
 * Run after a key rotation (see docs/security.md):
 *
 *   node scripts/reencrypt-secrets.ts --dry-run          # report only
 *   node scripts/reencrypt-secrets.ts                    # rewrite
 *   node scripts/reencrypt-secrets.ts --batch-size 200
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * ENCRYPTION_KEY and ENCRYPTION_KEY_PREVIOUS from the environment —
 * export them or use `node --env-file=.env.local scripts/reencrypt-secrets.ts`.
 *
 * Node 24 executes TypeScript directly (type stripping); no build step.
 * Exit code 1 when any row could not be re-encrypted, so a rotation
 * runbook can gate "retire the old key" on a clean run.
 */

import { createClient } from '@supabase/supabase-js';
import { currentKeyId } from '../src/lib/whatsapp/encryption.ts';
import {
  reencryptAll,
  type ReencryptDb,
  type ReencryptStats,
} from '../src/lib/whatsapp/reencrypt.ts';

function parseArgs(argv: string[]): { dryRun: boolean; batchSize: number } {
  let dryRun = false;
  let batchSize = 100;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--batch-size') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error('--batch-size expects a positive integer');
      }
      batchSize = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/reencrypt-secrets.ts [--dry-run] [--batch-size N]'
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dryRun, batchSize };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const { dryRun, batchSize } = parseArgs(process.argv.slice(2));
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  // Validates ENCRYPTION_KEY / ENCRYPTION_KEY_PREVIOUS before touching the DB.
  const keyId = currentKeyId();

  console.log(
    `${dryRun ? '[dry-run] ' : ''}re-encrypting secrets under key ${keyId} (batch ${batchSize})`
  );

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as ReencryptDb;

  const stats = await reencryptAll(db, {
    dryRun,
    batchSize,
    log: (line) => console.log('  ' + line),
  });

  let failed = 0;
  for (const s of stats as ReencryptStats[]) {
    failed += s.failed;
    console.log(
      `${s.table}: scanned ${s.scanned}, ${dryRun ? 'would rewrite' : 'rewritten'} ${
        s.rewritten
      }, up to date ${s.skipped}, failed ${s.failed}`
    );
  }

  if (failed > 0) {
    console.error(
      `${failed} row(s) could not be re-encrypted. Do NOT retire the previous key until they are fixed or re-entered.`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
