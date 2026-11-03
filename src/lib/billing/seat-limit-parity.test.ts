import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PLAN_ID } from './entitlements';

// i12.1 (R33) — `account_seat_limit()` (migration 090) repeats in SQL
// what `getEntitlements` + `normalizeLimits` decide in TypeScript: the
// plan of a company without a subscription row is DEFAULT_PLAN_ID, and
// the seat limit is `operators`. If one side changes, this fails.

const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/090_invite_direct_join.sql'
);

function seatLimitBody(sql: string): string {
  const start = sql.indexOf(
    'CREATE OR REPLACE FUNCTION public.account_seat_limit'
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(open + 2, close);
}

describe('account_seat_limit ↔ getEntitlements', () => {
  const body = seatLimitBody(readFileSync(MIGRATION, 'utf8'));

  it('falls back to DEFAULT_PLAN_ID without a subscription', () => {
    expect(body).toContain(`'${DEFAULT_PLAN_ID}'`);
    expect(body).toMatch(/COALESCE\s*\(/);
  });

  it('reads the operators limit, and only when it is a number', () => {
    expect(body).toContain(`limits->'operators'`);
    expect(body).toContain(`jsonb_typeof(p.limits->'operators') = 'number'`);
  });
});
