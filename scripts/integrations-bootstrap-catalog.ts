// ============================================================
// scripts/integrations-bootstrap-catalog.ts — load a versioned
// integration catalogue (n13.5) into `integrations` and
// `integration_operations`, with the service-role key:
//
//   node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health
//
// Node 24 executes TypeScript directly (type stripping) — hence the
// explicit `.ts` import extensions and the absence of `@/` aliases.
//
// Idempotent by `slug` / `key`:
//   - a missing integration is created INACTIVE (the operator activates it
//     in /platform when ready); a missing operation is created with the
//     `is_active` of the definition;
//   - an existing row is patched only in the fields that differ from the
//     definition — never `slug`, never `is_active` (the operator owns it);
//   - an operation in the database but not in the definition is left
//     alone and reported as an orphan.
// A second identical run writes nothing.
//
// The catalogue is global (no `account_id`, n13.1). The script does not
// call `catalog-validate.ts` (it pulls `@/` and `node:net`); the
// definition is validated by its vitest suite and by the CHECKs of 091.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================

import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import type {
  CatalogIntegration,
  CatalogOperation,
  IntegrationCatalogDefinition,
} from '../src/lib/integrations/catalogs/definition.ts';
import { INTEGRATION_CATALOGS } from '../src/lib/integrations/catalogs/index.ts';

export interface CatalogStore {
  findIntegration(
    slug: string
  ): Promise<(CatalogIntegration & { id: string; is_active: boolean }) | null>;
  insertIntegration(
    row: CatalogIntegration & { is_active: false }
  ): Promise<{ id: string }>;
  updateIntegration(
    id: string,
    patch: Partial<CatalogIntegration>
  ): Promise<void>;
  listOperations(
    integrationId: string
  ): Promise<(CatalogOperation & { id: string })[]>;
  insertOperation(integrationId: string, row: CatalogOperation): Promise<void>;
  updateOperation(
    id: string,
    patch: Partial<Omit<CatalogOperation, 'key' | 'is_active'>>
  ): Promise<void>;
}

export type RowResult = 'created' | 'updated' | 'unchanged';

export interface BootstrapReport {
  integration: RowResult;
  operations: Record<string, RowResult>;
  orphans: string[];
}

const USAGE =
  'Usage: node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts <slug>';

/** Integration fields the script keeps in sync (no `slug`, no `is_active`). */
const INTEGRATION_SYNCED = [
  'name',
  'description',
  'logo_url',
  'base_url',
  'auth_scheme',
  'auth_header_name',
  'credential_help',
  'test_path',
  'sort_order',
] as const satisfies readonly (keyof CatalogIntegration)[];

/** Operation fields the script keeps in sync (no `key`, no `is_active`). */
const OPERATION_SYNCED = [
  'name',
  'description',
  'method',
  'path',
  'params',
  'outputs',
  'response_description',
  'sort_order',
  'ai_policy',
] as const satisfies readonly (keyof CatalogOperation)[];

/** The definition for `slug`; throws listing the valid slugs. */
export function resolveCatalog(
  slug: string | undefined
): IntegrationCatalogDefinition {
  const known = Object.keys(INTEGRATION_CATALOGS).sort();
  const definition =
    slug && Object.prototype.hasOwnProperty.call(INTEGRATION_CATALOGS, slug)
      ? INTEGRATION_CATALOGS[slug]
      : undefined;
  if (!definition) {
    throw new Error(
      `Unknown or missing catalogue slug. Valid slugs: ${known.join(', ')}. ${USAGE}`
    );
  }
  return definition;
}

/**
 * JSON with sorted object keys: Postgres stores jsonb with its own key
 * order, so a plain `JSON.stringify` would see a difference where there
 * is none.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function diff<T extends object, K extends keyof T>(
  current: T,
  wanted: T,
  fields: readonly K[]
): Partial<Pick<T, K>> {
  const patch: Partial<Pick<T, K>> = {};
  for (const field of fields) {
    if (stableStringify(current[field]) !== stableStringify(wanted[field])) {
      patch[field] = wanted[field];
    }
  }
  return patch;
}

function pick<T extends object, K extends keyof T>(
  row: T,
  fields: readonly K[]
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const field of fields) out[field] = row[field];
  return out;
}

export async function bootstrapIntegrationCatalog({
  store,
  definition,
  log = console.log,
}: {
  store: CatalogStore;
  definition: IntegrationCatalogDefinition;
  log?: (message: string) => void;
}): Promise<BootstrapReport> {
  const wanted = definition.integration;
  const report: BootstrapReport = {
    integration: 'unchanged',
    operations: {},
    orphans: [],
  };

  let integrationId: string;
  const existing = await store.findIntegration(wanted.slug);
  if (!existing) {
    const created = await store.insertIntegration({
      ...wanted,
      is_active: false,
    });
    integrationId = created.id;
    report.integration = 'created';
    log(
      `Integration ${wanted.slug}: created (inactive — activate it in /platform when ready)`
    );
  } else {
    integrationId = existing.id;
    const patch = diff(
      pick(existing, INTEGRATION_SYNCED),
      pick(wanted, INTEGRATION_SYNCED),
      INTEGRATION_SYNCED
    );
    if (Object.keys(patch).length > 0) {
      await store.updateIntegration(integrationId, patch);
      report.integration = 'updated';
      log(
        `Integration ${wanted.slug}: updated ${Object.keys(patch).join(', ')}`
      );
    } else {
      log(`Integration ${wanted.slug}: unchanged`);
    }
  }

  const current = await store.listOperations(integrationId);
  const currentByKey = new Map(current.map((op) => [op.key, op]));
  for (const defined of definition.operations) {
    // n13.7: sin política = `null` en la base, para poder quitarla.
    const op: CatalogOperation = {
      ...defined,
      ai_policy: defined.ai_policy ?? null,
    };
    const row = currentByKey.get(op.key);
    if (!row) {
      await store.insertOperation(integrationId, op);
      report.operations[op.key] = 'created';
      log(`  ${op.key}: created (${op.is_active ? 'active' : 'inactive'})`);
      continue;
    }
    const patch = diff(
      pick(row, OPERATION_SYNCED),
      pick(op, OPERATION_SYNCED),
      OPERATION_SYNCED
    );
    if (Object.keys(patch).length > 0) {
      await store.updateOperation(row.id, patch);
      report.operations[op.key] = 'updated';
      log(`  ${op.key}: updated ${Object.keys(patch).join(', ')}`);
    } else {
      report.operations[op.key] = 'unchanged';
      log(`  ${op.key}: unchanged`);
    }
  }

  const defined = new Set(definition.operations.map((op) => op.key));
  report.orphans = current
    .map((op) => op.key)
    .filter((key) => !defined.has(key))
    .sort();
  for (const key of report.orphans) {
    log(
      `WARNING: operation ${key} is in the database but not in the definition (left as is)`
    );
  }
  log('Done.');
  return report;
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    // Only the NAME of the variable, never a value.
    console.error(`Missing env ${name}. ${USAGE}`);
    process.exit(1);
  }
  return v;
}

const INTEGRATION_COLUMNS = `id, slug, is_active, ${INTEGRATION_SYNCED.join(', ')}`;
const OPERATION_COLUMNS = `id, key, is_active, ${OPERATION_SYNCED.join(', ')}`;

async function main(): Promise<void> {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  let definition: IntegrationCatalogDefinition;
  try {
    definition = resolveCatalog(process.argv[2]);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const store: CatalogStore = {
    async findIntegration(slug) {
      const { data, error } = await db
        .from('integrations')
        .select(INTEGRATION_COLUMNS)
        .eq('slug', slug)
        .maybeSingle();
      if (error) throw new Error(`integrations query failed: ${error.message}`);
      return data as Awaited<ReturnType<CatalogStore['findIntegration']>>;
    },
    async insertIntegration(row) {
      const { data, error } = await db
        .from('integrations')
        .insert(row)
        .select('id')
        .single();
      if (error)
        throw new Error(`integrations insert failed: ${error.message}`);
      return data as { id: string };
    },
    async updateIntegration(id, patch) {
      const { error } = await db
        .from('integrations')
        .update(patch)
        .eq('id', id);
      if (error)
        throw new Error(`integrations update failed: ${error.message}`);
    },
    async listOperations(integrationId) {
      const { data, error } = await db
        .from('integration_operations')
        .select(OPERATION_COLUMNS)
        .eq('integration_id', integrationId);
      if (error) {
        throw new Error(
          `integration_operations query failed: ${error.message}`
        );
      }
      return (data ?? []) as unknown as (CatalogOperation & { id: string })[];
    },
    async insertOperation(integrationId, row) {
      const { error } = await db
        .from('integration_operations')
        .insert({ ...row, integration_id: integrationId });
      if (error) {
        throw new Error(
          `integration_operations insert failed for ${row.key}: ${error.message}`
        );
      }
    },
    async updateOperation(id, patch) {
      const { error } = await db
        .from('integration_operations')
        .update(patch)
        .eq('id', id);
      if (error) {
        throw new Error(
          `integration_operations update failed: ${error.message}`
        );
      }
    },
  };

  await bootstrapIntegrationCatalog({ store, definition });
}

// Run only when invoked as `node scripts/integrations-bootstrap-catalog.ts`.
// The test imports the exported logic and must not open a client.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'bootstrap failed');
    process.exit(1);
  });
}
