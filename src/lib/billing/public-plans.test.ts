import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  formatCount,
  META_FREE_SERVICE_PER_NUMBER,
  metaFreeServiceFor,
  PUBLIC_PLANS,
} from './public-plans';

/**
 * p11.2: `/precios` cannot read `plans` (RLS: authenticated only), so it
 * renders `PUBLIC_PLANS`. These tests keep that constant equal to what
 * the migrations leave in the table: the 041 seed for limits, and the
 * last `UPDATE plans SET price_usd_month … WHERE id = …` for prices.
 */

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

function migrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS, name), 'utf8'),
    }));
}

/** Rows of the 041 seed: id → { month, year, limits }. */
function seed() {
  const sql = readFileSync(join(MIGRATIONS, '041_billing_model.sql'), 'utf8');
  const rows = new Map<
    string,
    { month: number; year: number; limits: Record<string, number | null> }
  >();
  const re =
    /\(\s*'([a-z_]+)',\s*'[^']+',\s*(\d+),\s*(\d+),\s*'(\{[^']+\})'::jsonb/g;
  for (const m of sql.matchAll(re)) {
    rows.set(m[1], {
      month: Number(m[2]),
      year: Number(m[3]),
      limits: JSON.parse(m[4]) as Record<string, number | null>,
    });
  }
  return rows;
}

/** The price each plan ends up with after every migration ran in order. */
function finalPrices() {
  const prices = new Map<string, { month: number; year: number }>();
  for (const [id, row] of seed()) {
    prices.set(id, { month: row.month, year: row.year });
  }
  const re =
    /UPDATE plans\s+SET price_usd_month\s*=\s*(\d+),\s*price_usd_year\s*=\s*(\d+)\s+WHERE id\s*=\s*'([a-z_]+)'/g;
  for (const { sql } of migrations()) {
    for (const m of sql.matchAll(re)) {
      prices.set(m[3], { month: Number(m[1]), year: Number(m[2]) });
    }
  }
  return prices;
}

describe('PUBLIC_PLANS', () => {
  it('lists the public catalogue: inicio, pro and negocio, in order', () => {
    expect(PUBLIC_PLANS.map((p) => p.id)).toEqual(['inicio', 'pro', 'negocio']);
  });

  it('matches the limits of the 041 seed', () => {
    const rows = seed();
    expect(rows.size).toBe(3);
    for (const plan of PUBLIC_PLANS) {
      const row = rows.get(plan.id);
      expect(row, plan.id).toBeDefined();
      for (const [key, value] of Object.entries(plan.limits)) {
        expect(row!.limits[key], `${plan.id}.${key}`).toBe(value);
      }
    }
  });

  it('matches the prices left by the last catalogue migration (059, 065)', () => {
    const prices = finalPrices();
    for (const plan of PUBLIC_PLANS) {
      expect(prices.get(plan.id), plan.id).toEqual({
        month: plan.priceUsdMonth,
        year: plan.priceUsdYear,
      });
    }
    // Guard the parser: the revisions it must have seen.
    expect(prices.get('inicio')?.month).toBe(35);
    expect(prices.get('pro')?.month).toBe(100);
  });

  it('never publishes a hidden plan', () => {
    const ids = PUBLIC_PLANS.map((p) => p.id as string);
    expect(ids).not.toContain('ilimitado');
    expect(ids).not.toContain('gestionado');
  });
});

describe("Meta's free service allowance", () => {
  it('is 1,000 per number: Negocio with 3 numbers gets 3,000', () => {
    expect(META_FREE_SERVICE_PER_NUMBER).toBe(1000);
    expect(metaFreeServiceFor(1)).toBe(1000);
    expect(metaFreeServiceFor(3)).toBe(3000);
    const negocio = PUBLIC_PLANS.find((p) => p.id === 'negocio')!;
    expect(metaFreeServiceFor(negocio.limits.numbers)).toBe(3000);
    expect(metaFreeServiceFor(0)).toBe(0);
    expect(metaFreeServiceFor(-2)).toBe(0);
  });

  it('formats counts the way each catalogue writes them', () => {
    expect(formatCount(3000, 'es')).toBe('3.000');
    expect(formatCount(3000, 'en')).toBe('3,000');
    expect(formatCount(60000, 'es')).toBe('60.000');
    expect(formatCount(1990, 'en')).toBe('1,990');
    expect(formatCount(500, 'es')).toBe('500');
  });
});
