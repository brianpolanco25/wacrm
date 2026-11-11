import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  bootstrapIntegrationCatalog,
  resolveCatalog,
  stableStringify,
  type CatalogStore,
} from '../../../../scripts/integrations-bootstrap-catalog.ts';
import { CABBITY_HEALTH_CATALOG } from './cabbity-health';
import type {
  CatalogIntegration,
  CatalogOperation,
  IntegrationCatalogDefinition,
} from './definition';

// n13.5 (R5–R8, R26): carga idempotente del catálogo con un almacén en
// memoria, archivos ejecutables por Node sin alias y documentación.

type StoredIntegration = CatalogIntegration & {
  id: string;
  is_active: boolean;
};
type StoredOperation = CatalogOperation & {
  id: string;
  integration_id: string;
};

/** Clona como lo haría un viaje por jsonb: claves en otro orden. */
function reorder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reorder) as T;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, reorder(v)])) as T;
  }
  return value;
}

class MemoryStore implements CatalogStore {
  integrations: StoredIntegration[] = [];
  operations: StoredOperation[] = [];
  writes: string[] = [];
  private seq = 0;

  async findIntegration(slug: string) {
    const row = this.integrations.find((r) => r.slug === slug);
    return row ? reorder(row) : null;
  }
  async insertIntegration(row: CatalogIntegration & { is_active: false }) {
    const id = `int-${++this.seq}`;
    this.integrations.push({ ...reorder(row), id });
    this.writes.push(`insertIntegration ${row.slug}`);
    return { id };
  }
  async updateIntegration(id: string, patch: Partial<CatalogIntegration>) {
    const row = this.integrations.find((r) => r.id === id)!;
    Object.assign(row, patch);
    this.writes.push(`updateIntegration ${Object.keys(patch).join(',')}`);
  }
  async listOperations(integrationId: string) {
    return this.operations
      .filter((o) => o.integration_id === integrationId)
      .map((o) => reorder(o));
  }
  async insertOperation(integrationId: string, row: CatalogOperation) {
    this.operations.push({
      ...reorder(row),
      id: `op-${++this.seq}`,
      integration_id: integrationId,
    });
    this.writes.push(`insertOperation ${row.key}`);
  }
  async updateOperation(
    id: string,
    patch: Partial<Omit<CatalogOperation, 'key' | 'is_active'>>
  ) {
    const row = this.operations.find((o) => o.id === id)!;
    Object.assign(row, patch);
    this.writes.push(
      `updateOperation ${row.key} ${Object.keys(patch).join(',')}`
    );
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

async function load(
  store: MemoryStore,
  definition: IntegrationCatalogDefinition = CABBITY_HEALTH_CATALOG
) {
  const logs: string[] = [];
  const report = await bootstrapIntegrationCatalog({
    store,
    definition,
    log: (m) => logs.push(m),
  });
  return { report, logs };
}

describe('bootstrapIntegrationCatalog (R5): empty store', () => {
  it('creates the integration inactive and the 16 operations with their is_active', async () => {
    const store = new MemoryStore();
    const { report } = await load(store);
    expect(report.integration).toBe('created');
    expect(store.integrations).toHaveLength(1);
    expect(store.integrations[0]).toMatchObject({
      slug: 'cabbity-health',
      is_active: false,
    });
    expect(store.operations).toHaveLength(16);
    expect(Object.values(report.operations)).toEqual(Array(16).fill('created'));
    const off = store.operations
      .filter((o) => !o.is_active)
      .map((o) => o.key)
      .sort();
    expect(off).toEqual(['get_patient', 'list_patients']);
    expect(report.orphans).toEqual([]);
  });
});

describe('bootstrapIntegrationCatalog (R6): existing rows', () => {
  it('a second identical run writes nothing and reports unchanged', async () => {
    const store = new MemoryStore();
    await load(store);
    store.writes = [];
    const { report } = await load(store);
    expect(store.writes).toEqual([]);
    expect(report.integration).toBe('unchanged');
    expect(Object.values(report.operations)).toEqual(
      Array(16).fill('unchanged')
    );
  });

  it('keeps the is_active the operator chose', async () => {
    const store = new MemoryStore();
    await load(store);
    store.integrations[0].is_active = true;
    store.operations.find((o) => o.key === 'list_patients')!.is_active = true;
    store.operations.find((o) => o.key === 'cancel_appointment')!.is_active =
      false;
    store.writes = [];
    await load(store);
    expect(store.writes).toEqual([]);
    expect(store.integrations[0].is_active).toBe(true);
    expect(
      store.operations.find((o) => o.key === 'list_patients')!.is_active
    ).toBe(true);
    expect(
      store.operations.find((o) => o.key === 'cancel_appointment')!.is_active
    ).toBe(false);
  });

  it('patches only the field that changed', async () => {
    const store = new MemoryStore();
    await load(store);
    store.writes = [];
    const changed = clone(CABBITY_HEALTH_CATALOG);
    changed.integration.description = 'Otra descripción';
    changed.operations[5].description = 'Nueva descripción de disponibilidad';
    changed.operations[5].is_active = false; // ignored for an existing row
    const { report } = await load(store, changed);
    expect(store.writes).toEqual([
      'updateIntegration description',
      'updateOperation find_availability description',
    ]);
    expect(report.integration).toBe('updated');
    expect(report.operations.find_availability).toBe('updated');
    expect(
      store.operations.find((o) => o.key === 'find_availability')!.is_active
    ).toBe(true);
  });

  // n13.8 (A3): una fila cargada antes de `normalize` recibe los params y
  // las descripciones nuevas al volver a correr el script.
  it('syncs params and description into rows loaded before n13.8', async () => {
    const store = new MemoryStore();
    await load(store);
    const old = store.operations.find((o) => o.key === 'create_patient')!;
    old.params = old.params.map((p) => {
      if (p.name !== 'document_number') return p;
      const legacy = { ...p, description: 'Número de documento.' };
      delete legacy.normalize;
      return legacy;
    });
    old.description = 'Pide al cliente su consentimiento expreso.';
    store.writes = [];
    const { report } = await load(store);
    expect(store.writes).toEqual([
      'updateOperation create_patient description,params',
    ]);
    expect(report.operations.create_patient).toBe('updated');
    const synced = store.operations.find((o) => o.key === 'create_patient')!;
    expect(
      synced.params.find((p) => p.name === 'document_number')?.normalize
    ).toBe('compact');
    expect(synced.description).not.toMatch(/consentimiento expreso/);
  });

  it('creates a missing operation and warns about an orphan without writing it', async () => {
    const store = new MemoryStore();
    await load(store);
    store.operations = store.operations.filter((o) => o.key !== 'get_center');
    store.operations.push({
      ...clone(CABBITY_HEALTH_CATALOG.operations[1]),
      key: 'legacy_op',
      id: 'op-legacy',
      integration_id: store.integrations[0].id,
    });
    store.writes = [];
    const { report, logs } = await load(store);
    expect(store.writes).toEqual(['insertOperation get_center']);
    expect(report.operations.get_center).toBe('created');
    expect(report.orphans).toEqual(['legacy_op']);
    expect(
      logs.some((l) => l.startsWith('WARNING') && l.includes('legacy_op'))
    ).toBe(true);
  });
});

describe('stableStringify', () => {
  it('ignores key order (jsonb reorders keys)', () => {
    const a = CABBITY_HEALTH_CATALOG.operations[8].params;
    expect(stableStringify(reorder(a))).toBe(stableStringify(a));
    expect(stableStringify({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      stableStringify({ b: [1, { d: 3, c: 2 }], a: 1 })
    );
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe('resolveCatalog (R7)', () => {
  it('returns the registered definition', () => {
    expect(resolveCatalog('cabbity-health')).toBe(CABBITY_HEALTH_CATALOG);
  });

  it.each([undefined, '', 'nope', 'constructor', '__proto__'])(
    '%s → an error listing the valid slugs',
    (slug) => {
      expect(() => resolveCatalog(slug)).toThrow(/Valid slugs: cabbity-health/);
    }
  );
});

// R8: lo que ejecuta Node 24 sin compilar, sin alias y sin claves.
const CATALOG_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const KEY_RE = /chk_(live|test)_[A-Za-z0-9]{8,}/;

describe('catalog files are runnable by Node and carry no key (R8)', () => {
  const files = readdirSync(CATALOG_DIR).filter(
    (f) => f.endsWith('.ts') && !f.includes('.test.')
  );

  it('there are definition files to check', () => {
    expect(files.sort()).toEqual(
      expect.arrayContaining(['cabbity-health.ts', 'definition.ts', 'index.ts'])
    );
  });

  it.each(files)('%s', (file) => {
    const text = readFileSync(`${CATALOG_DIR}${file}`, 'utf8');
    expect(text).not.toMatch(/from\s+['"]@\//);
    expect(text).not.toMatch(KEY_RE);
    const imports = [
      ...text.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/gm),
    ];
    for (const [, isType, source] of imports) {
      if (isType) {
        expect(source).toMatch(/\.ts$/);
      } else {
        expect([file, source]).toEqual([
          file,
          expect.stringMatching(/^\.\/[^/]+\.ts$/),
        ]);
      }
    }
  });

  it('the bootstrap script imports no alias and no key', () => {
    const text = readFileSync(
      `${ROOT}scripts/integrations-bootstrap-catalog.ts`,
      'utf8'
    );
    expect(text).not.toMatch(/from\s+['"]@\//);
    expect(text).not.toMatch(KEY_RE);
  });
});

describe('docs/integrations/cabbity-health.md (R8, R26)', () => {
  const doc = readFileSync(
    `${ROOT}docs/integrations/cabbity-health.md`,
    'utf8'
  );

  it('has the load command, the limits and the error codes', () => {
    expect(doc).toContain(
      'node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health'
    );
    for (const piece of [
      '120',
      '3 citas',
      '13',
      'idempotency_mismatch',
      'api_key_expired',
      'list_patients',
      'get_patient',
    ]) {
      expect(doc).toContain(piece);
    }
  });

  it('carries no key', () => {
    expect(doc).not.toMatch(KEY_RE);
  });
});

// n13.7 R25: `ai_policy` se sincroniza en filas existentes.
describe('bootstrapIntegrationCatalog: ai_policy (n13.7, R25)', () => {
  it('a row loaded before n13.7 (ai_policy null) gets the policy', async () => {
    const store = new MemoryStore();
    await load(store);
    const cancel = store.operations.find(
      (o) => o.key === 'cancel_appointment'
    )!;
    cancel.ai_policy = null;
    store.writes = [];
    const { report } = await load(store);
    expect(store.writes).toEqual([
      'updateOperation cancel_appointment ai_policy',
    ]);
    expect(report.operations.cancel_appointment).toBe('updated');
    expect(cancel.ai_policy).toEqual({
      requires_prior: [
        ['list_appointments', 'get_appointment'],
        ['find_availability'],
      ],
    });
  });

  it('an equal policy (keys reordered by jsonb) is unchanged', async () => {
    const store = new MemoryStore();
    await load(store);
    store.writes = [];
    const { report } = await load(store);
    expect(store.writes).toEqual([]);
    expect(report.operations.find_availability).toBe('unchanged');
  });

  it('an operation without policy in the definition clears a stored one (null)', async () => {
    const store = new MemoryStore();
    await load(store);
    const center = store.operations.find((o) => o.key === 'get_center')!;
    expect(center.ai_policy).toBeNull();
    center.ai_policy = { grounds: ['schedule'] };
    store.writes = [];
    await load(store);
    expect(store.writes).toEqual(['updateOperation get_center ai_policy']);
    expect(center.ai_policy).toBeNull();
  });
});
