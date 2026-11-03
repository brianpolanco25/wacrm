import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PLAN_FEATURES,
  PLAN_LIMIT_KEYS,
  validateFeatures,
  validateLimits,
} from './plan-catalog';

// ------------------------------------------------------------
// The `ilimitado` plan of migration 074 (s9.7) against the inventories
// of plan-catalog.ts. The replay (scripts/replay-migrations.sh +
// verify-schema.sql) executes the SQL; this pins the contract in the
// gate: a feature added to the inventory without adding it to the
// unlimited plan fails here, instead of shipping an "unlimited" plan
// that lacks it.
// ------------------------------------------------------------

const MIGRATION = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/074_plan_ilimitado.sql'),
  'utf8'
);

/** The `INSERT INTO plans … ON CONFLICT … ;` statement, comments stripped. */
function planInsert(): string {
  const code = MIGRATION.replace(/--[^\n]*/g, '');
  const start = code.indexOf('INSERT INTO plans');
  expect(start).toBeGreaterThanOrEqual(0);
  return code.slice(start, code.indexOf(';', start) + 1);
}

/**
 * Features a LATER migration added to the inventory with its marker line
 * (`-- Claves de \`features\` añadidas: x.`), e.g. `integrations` (091).
 * Those ship off on every plan by decision (n13.1, D2): the operator
 * ticks them in /platform/plans, the migration gives them to no plan —
 * not even this one.
 */
function featuresAddedAfter(migration: number): string[] {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  const out: string[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (Number(file.slice(0, 3)) <= migration) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(
      /^-- Claves de `features` añadidas:\s*([^\n]+)$/gm
    )) {
      out.push(...m[1].split(/[\s,.]+/).filter(Boolean));
    }
  }
  return out;
}

const INVENTORY_074 = PLAN_FEATURES.filter(
  (f) => !featuresAddedAfter(74).includes(f)
);

describe('plan ilimitado (074)', () => {
  it('has every limit key of the inventory, all null', () => {
    const blob = /'(\{[^']*\})'::jsonb/.exec(planInsert());
    expect(blob).not.toBeNull();
    const limits = JSON.parse(blob![1]) as Record<string, unknown>;
    expect(Object.keys(limits).sort()).toEqual([...PLAN_LIMIT_KEYS].sort());
    expect(Object.values(limits).every((v) => v === null)).toBe(true);
    // And the editor of s9.3 would accept it as is.
    expect(validateLimits(limits).ok).toBe(true);
  });

  it('has every feature of the inventory, in the inventory order', () => {
    const array = /ARRAY\[([^\]]*)\]::text\[\]/.exec(planInsert());
    expect(array).not.toBeNull();
    const features = [...array![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(features).toEqual(INVENTORY_074);
    const validated = validateFeatures(features);
    expect(validated).toEqual({ ok: true, value: INVENTORY_074 });
  });

  it('is hidden, free, last, and never touches the PayPal ids', () => {
    const insert = planInsert();
    expect(insert).toMatch(
      /VALUES\s*\(\s*'ilimitado',\s*'Ilimitado',\s*'[^']+',\s*0,\s*0,/
    );
    expect(insert).toMatch(/false,\s*99\s*\)/);
    expect(insert).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/);
    expect(MIGRATION).not.toMatch(/provider_plan_id_(month|year)/);
  });

  it('assigns it by hand, audited, and grants the operator by email', () => {
    const code = MIGRATION.replace(/--[^\n]*/g, '');
    expect(code).toMatch(
      /lower\(btrim\(u\.email\)\) = 'brianmpolanco@gmail\.com'/
    );
    expect(code).toMatch(
      /'ilimitado', 'manual', 'active', NULL,\s*NULL, NULL, NULL, NULL, false/
    );
    expect(code).toMatch(/ON CONFLICT \(account_id\) DO UPDATE SET/);
    expect(code).not.toMatch(/manual_hold_/);
    expect(code).toMatch(/'plan_override', v_acc\.owner_user_id/);
    expect(code).toContain(
      'Plan ilimitado de la empresa propietaria del servicio (migración 074)'
    );
    expect(code).toMatch(
      /INSERT INTO platform_admins[\s\S]*'brianpolancodisenos@gmail\.com'[\s\S]*ON CONFLICT \(user_id\) DO NOTHING/
    );
    // Only confirmed users, in both lookups.
    expect(code.match(/u\.confirmed_at IS NOT NULL/g)).toHaveLength(2);
  });
});
