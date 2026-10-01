import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseMetaPricing } from './meta-pricing';
import {
  PLAN_FEATURES,
  PLAN_LIMIT_KEYS,
  validateFeatures,
  validateLimits,
} from './plan-catalog';

// ------------------------------------------------------------
// The `gestionado` plan of migration 077 (s10.3) against the inventories
// of plan-catalog.ts and the price validator, and the places a customer
// could see it. The replay (scripts/replay-migrations.sh +
// verify-schema.sql) executes the SQL; this pins the contract in the
// gate.
// ------------------------------------------------------------

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), 'utf8');

const MIGRATION = read('supabase/migrations/077_plan_gestionado.sql');
const CODE = MIGRATION.replace(/--[^\n]*/g, '');

function statement(start: string): string {
  const at = CODE.indexOf(start);
  expect(at).toBeGreaterThanOrEqual(0);
  return CODE.slice(at, CODE.indexOf(';', at) + 1);
}

const NEGOCIO_041 = {
  operators: 30,
  contacts: 50000,
  messages_out: 60000,
  ai_replies: 15000,
  broadcast_recipients: 50000,
  knowledge_documents: 200,
  numbers: 3,
  retention_months: null,
};

describe('plan gestionado (077)', () => {
  const insert = statement('INSERT INTO plans');

  it('is hidden, 1036 a month, no yearly price', () => {
    expect(insert).toMatch(/'gestionado', 'Gestionado'/);
    expect(insert).toMatch(/1036, NULL,/);
    expect(insert).toMatch(/false, 90\s*\)/);
  });

  it('has the limits of negocio with no cap on sends', () => {
    const blob = /'(\{[^']*\})'::jsonb/.exec(insert);
    const limits = JSON.parse(blob![1]) as Record<string, unknown>;
    expect(Object.keys(limits).sort()).toEqual([...PLAN_LIMIT_KEYS].sort());
    expect(validateLimits(limits).ok).toBe(true);
    expect(limits).toEqual({
      ...NEGOCIO_041,
      messages_out: null,
      broadcast_recipients: null,
    });
  });

  it('has every feature of the inventory', () => {
    const array = /ARRAY\[([^\]]*)\]/.exec(insert)![1];
    const features = [...array.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(validateFeatures(features).ok).toBe(true);
    expect(features.sort()).toEqual([...PLAN_FEATURES].sort());
  });

  it('seeds a default price the validator accepts: 7000 included, 1036, ×2,5', () => {
    const update = statement('UPDATE plans');
    const blob = /SET meta_pricing = '([^']*)'::jsonb/.exec(update)![1];
    const parsed = parseMetaPricing(JSON.parse(blob));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual({
      included_messages: 7000,
      fee_usd: 1036,
      overage: {
        service: { multiplier: 2.5 },
        utility: { multiplier: 2.5 },
        marketing: { multiplier: 2.5 },
        authentication: { multiplier: 2.5 },
        authentication_international: { multiplier: 2.5 },
      },
    });
    // Only on a plan with no policy yet: an operator's edit survives.
    expect(update).toMatch(/meta_pricing = '\{\}'::jsonb\s*;/);
  });

  it('keeps an operator edit on a second run (ON CONFLICT DO NOTHING)', () => {
    expect(insert).toMatch(/ON CONFLICT \(id\) DO NOTHING;/);
  });
});

describe('a customer never sees it', () => {
  it('the plan picker of /billing and onboarding reads /api/billing/plans only', () => {
    const picker = read('src/components/billing/plan-picker.tsx');
    expect(picker).toContain("fetch('/api/billing/plans'");
    expect(picker).not.toContain('/api/platform/');
    const onboarding = read('src/components/onboarding/onboarding-flow.tsx');
    expect(onboarding).toContain('<PlanPicker');
    expect(onboarding).not.toContain('/api/platform/');
  });

  it('/api/billing/plans filters is_public in the query, and checkout refuses a hidden plan', () => {
    expect(read('src/app/api/billing/plans/route.ts')).toContain(
      ".eq('is_public', true)"
    );
    expect(read('src/app/api/billing/checkout/route.ts')).toContain(
      '!plan.is_public'
    );
  });

  it('the CLI bootstrap only publishes plans that are for sale', () => {
    expect(read('scripts/paypal-bootstrap-catalog.ts')).toContain(
      ".eq('is_public', true)"
    );
  });
});
