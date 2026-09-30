import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PLAN_FEATURES,
  PLAN_ID_RE,
  PLAN_LIMIT_KEYS,
  validateFeatures,
  validateLimits,
  validatePlanInput,
} from './plan-catalog';
import { USAGE_METRICS } from './subscription-view';

// ------------------------------------------------------------
// The inventories against the seed and against the code (s9.3).
// ------------------------------------------------------------

const ROOT = process.cwd();
const SEED = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/041_billing_model.sql'),
  'utf8'
);

/** Every non-test .ts/.tsx under src/. */
function sourceFiles(dir = path.join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      out.push(full);
  }
  return out;
}

function stringArgs(re: RegExp): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) found.add(m[1]);
  }
  return found;
}

describe('the plan inventories (s9.3)', () => {
  it('limit keys are exactly the ones the 041 seed documents and writes', () => {
    const documented =
      /Claves de `limits`:\s*--\s*([^\n]+)\n--\s*([^\n]+)/.exec(SEED);
    expect(documented).not.toBeNull();
    const keys = `${documented![1]} ${documented![2]}`
      .split(/[\s,.]+/)
      .filter(Boolean);
    expect([...keys].sort()).toEqual([...PLAN_LIMIT_KEYS].sort());

    // And every seeded row carries exactly those keys.
    const insert = SEED.slice(SEED.indexOf('INSERT INTO plans'));
    const blobs = [...insert.matchAll(/'(\{[^']*\})'::jsonb/g)].map((m) =>
      Object.keys(JSON.parse(m[1]))
    );
    expect(blobs).toHaveLength(3);
    for (const blob of blobs) {
      expect(blob.sort()).toEqual([...PLAN_LIMIT_KEYS].sort());
    }
  });

  it('feature keys are exactly the ones the 041 seed documents', () => {
    const documented =
      /Claves de `features`:\s*--\s*([^\n]+)\n--\s*([^\n]+)/.exec(SEED);
    expect(documented).not.toBeNull();
    const keys = `${documented![1]} ${documented![2]}`
      .split(/[\s,.]+/)
      .filter(Boolean);
    expect([...keys].sort()).toEqual([...PLAN_FEATURES].sort());
  });

  it('every feature the code checks is in the inventory', () => {
    const checked = stringArgs(
      /\b(?:assertPlanFeature|hasFeature|assertFeature)\([^)]*?'([a-z_]+)'/g
    );
    // A guard against the regex matching nothing and the test passing
    // on an empty set: api, webhooks and ai_autoreply are checked today.
    expect(checked.size).toBeGreaterThanOrEqual(3);
    for (const feature of checked) {
      expect(PLAN_FEATURES as readonly string[]).toContain(feature);
    }
  });

  it('every limit the code enforces is in the inventory', () => {
    const enforced = stringArgs(
      /\b(?:assertQuota|assertStockLimit)\([^,]+,\s*'([a-z_]+)'/g
    );
    expect(enforced.size).toBeGreaterThanOrEqual(4);
    for (const metric of [...enforced, ...USAGE_METRICS]) {
      expect(PLAN_LIMIT_KEYS as readonly string[]).toContain(metric);
    }
  });
});

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

const LIMITS = {
  operators: 3,
  contacts: 2000,
  messages_out: 3000,
  ai_replies: 500,
  broadcast_recipients: 2000,
  knowledge_documents: 10,
  numbers: 1,
  retention_months: null,
};

const CREATE = {
  id: 'plus',
  name: 'Plus',
  price_usd_month: 49,
  price_usd_year: 490,
  limits: LIMITS,
  features: ['api', 'ai_autoreply'],
  is_public: false,
  sort_order: 4,
  description: 'Para equipos medianos',
};

describe('validatePlanInput — create', () => {
  it('accepts a full plan and orders the features like the inventory', () => {
    const result = validatePlanInput(CREATE, 'create');
    expect(result).toEqual({
      ok: true,
      value: { ...CREATE, features: ['ai_autoreply', 'api'] },
    });
  });

  it.each([
    ['uppercase', 'Plus'],
    ['one letter', 'p'],
    ['leading digit', '1plus'],
    ['a space', 'pl us'],
    ['33 characters', 'p' + 'x'.repeat(32)],
    ['not a string', 7],
  ])('refuses an id with %s', (_label, id) => {
    const result = validatePlanInput({ ...CREATE, id }, 'create');
    expect(result.ok).toBe(false);
  });

  it('accepts the seeded ids as slugs', () => {
    for (const id of ['inicio', 'pro', 'negocio', 'ilimitado', 'a-1_b']) {
      expect(PLAN_ID_RE.test(id)).toBe(true);
    }
  });

  it.each(['name', 'price_usd_month', 'limits', 'features'])(
    'requires %s',
    (field) => {
      const body: Record<string, unknown> = { ...CREATE };
      delete body[field];
      expect(validatePlanInput(body, 'create').ok).toBe(false);
    }
  );

  it('refuses unknown fields, including the PayPal ids', () => {
    for (const extra of ['provider_plan_id_month', 'account_id', 'foo']) {
      const result = validatePlanInput({ ...CREATE, [extra]: 'x' }, 'create');
      expect(result).toEqual({
        ok: false,
        error: `unknown field '${extra}'`,
      });
    }
  });

  it.each([
    ['negative', -1],
    ['three decimals', 9.999],
    ['a string', '49'],
    ['too big', 100_000_000],
    ['NaN', Number.NaN],
  ])('refuses a %s monthly price', (_label, price) => {
    expect(
      validatePlanInput({ ...CREATE, price_usd_month: price }, 'create').ok
    ).toBe(false);
  });

  it('accepts a free plan and a missing yearly price', () => {
    const body: Record<string, unknown> = { ...CREATE, price_usd_month: 0 };
    delete body.price_usd_year;
    expect(validatePlanInput(body, 'create').ok).toBe(true);
    expect(
      validatePlanInput({ ...CREATE, price_usd_year: null }, 'create').ok
    ).toBe(true);
  });

  it('refuses a non-boolean is_public and a non-integer sort_order', () => {
    expect(
      validatePlanInput({ ...CREATE, is_public: 'yes' }, 'create').ok
    ).toBe(false);
    expect(validatePlanInput({ ...CREATE, sort_order: 1.5 }, 'create').ok).toBe(
      false
    );
  });

  it('trims the name and blanks an empty description to null', () => {
    const result = validatePlanInput(
      { ...CREATE, name: '  Plus  ', description: '   ' },
      'create'
    );
    expect(result).toMatchObject({
      ok: true,
      value: { name: 'Plus', description: null },
    });
  });
});

describe('validateLimits', () => {
  it('keeps null as unlimited', () => {
    expect(validateLimits(LIMITS)).toEqual({ ok: true, value: LIMITS });
  });

  it('refuses a metric the product does not know', () => {
    expect(validateLimits({ ...LIMITS, seats: 3 })).toEqual({
      ok: false,
      error: "unknown limit 'seats'",
    });
  });

  it('refuses a missing metric instead of treating it as unlimited', () => {
    const partial: Record<string, unknown> = { ...LIMITS };
    delete partial.messages_out;
    expect(validateLimits(partial).ok).toBe(false);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '10'],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a %s value', (_label, value) => {
    expect(validateLimits({ ...LIMITS, operators: value }).ok).toBe(false);
  });

  it('refuses a non-object', () => {
    expect(validateLimits([]).ok).toBe(false);
    expect(validateLimits(null).ok).toBe(false);
  });
});

describe('validateFeatures', () => {
  it('refuses an unknown feature', () => {
    expect(validateFeatures(['api', 'teleport'])).toEqual({
      ok: false,
      error: "unknown feature 'teleport'",
    });
  });

  it('dedupes', () => {
    expect(validateFeatures(['api', 'api'])).toEqual({
      ok: true,
      value: ['api'],
    });
  });
});

describe('validatePlanInput — update', () => {
  it('takes a subset of fields', () => {
    expect(validatePlanInput({ price_usd_month: 55 }, 'update')).toEqual({
      ok: true,
      value: { price_usd_month: 55 },
    });
  });

  it('refuses to change the id, even to the same value', () => {
    expect(validatePlanInput({ id: 'pro', name: 'Pro' }, 'update')).toEqual({
      ok: false,
      error: 'the plan id cannot be changed',
    });
  });

  it('refuses an empty edit', () => {
    expect(validatePlanInput({}, 'update').ok).toBe(false);
  });

  it('validates the limits of an edit as strictly as a create', () => {
    expect(validatePlanInput({ limits: { operators: 3 } }, 'update').ok).toBe(
      false
    );
  });
});
