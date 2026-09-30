import { describe, expect, it } from 'vitest';

import {
  currentPayPalEnv,
  cycleSync,
  publishablePrice,
  toPlatformPlan,
  type HistoryRow,
  type PlanRow,
} from './plan-sync';

// The sync state the panel shows per plan and cycle (s9.3). The routes
// exercise the same functions end to end; these pin the edge cases.

const PLAN: PlanRow = {
  id: 'pro',
  name: 'Pro',
  description: null,
  price_usd_month: '100.00',
  price_usd_year: '1000.00',
  limits: {},
  features: [],
  is_public: true,
  sort_order: 2,
  created_at: null,
  updated_at: null,
  provider_plan_id_month: 'P-M',
  provider_plan_id_year: null,
};

function row(overrides: Partial<HistoryRow>): HistoryRow {
  return {
    id: 'h',
    plan_id: 'pro',
    cycle: 'month',
    provider: 'paypal',
    provider_plan_id: 'P-M',
    price_usd: '100.00',
    provider_env: 'sandbox',
    created_at: '2026-02-01T00:00:00Z',
    replaced_at: null,
    replaced_by: null,
    created_by: null,
    ...overrides,
  };
}

describe('cycleSync', () => {
  it('unpublished without an id', () => {
    expect(cycleSync(PLAN, 'year', []).state).toBe('unpublished');
  });

  it('synced when the open row of THIS id has the same price', () => {
    expect(cycleSync(PLAN, 'month', [row({ price_usd: 100 })])).toEqual({
      state: 'synced',
      providerPlanId: 'P-M',
      syncedPrice: '100.00',
    });
  });

  it('price_mismatch when it was created at another price', () => {
    expect(cycleSync(PLAN, 'month', [row({ price_usd: '79' })]).state).toBe(
      'price_mismatch'
    );
  });

  it('price_mismatch when the price was set to 0 after publishing', () => {
    expect(
      cycleSync({ ...PLAN, price_usd_month: 0 }, 'month', [row({})]).state
    ).toBe('price_mismatch');
  });

  it('unknown without history, or when the only row is closed or for another id', () => {
    expect(cycleSync(PLAN, 'month', []).state).toBe('unknown');
    expect(
      cycleSync(PLAN, 'month', [row({ replaced_at: '2026-03-01T00:00:00Z' })])
        .state
    ).toBe('unknown');
    expect(
      cycleSync(PLAN, 'month', [row({ provider_plan_id: 'P-OTHER' })]).state
    ).toBe('unknown');
    expect(cycleSync(PLAN, 'month', [row({ cycle: 'year' })]).state).toBe(
      'unknown'
    );
  });
});

describe('helpers', () => {
  it('publishablePrice refuses 0 and null', () => {
    expect(publishablePrice(PLAN, 'month')).toBe('100.00');
    expect(publishablePrice({ ...PLAN, price_usd_year: null }, 'year')).toBe(
      null
    );
    expect(publishablePrice({ ...PLAN, price_usd_month: 0 }, 'month')).toBe(
      null
    );
  });

  it('currentPayPalEnv is sandbox unless exactly live', () => {
    expect(currentPayPalEnv('live')).toBe('live');
    expect(currentPayPalEnv('LIVE')).toBe('sandbox');
    expect(currentPayPalEnv(undefined)).toBe('sandbox');
  });

  it('toPlatformPlan keeps only this plan’s history, newest first', () => {
    const out = toPlatformPlan(PLAN, [
      row({ id: 'a', created_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'b', created_at: '2026-03-01T00:00:00Z' }),
      row({ id: 'c', plan_id: 'inicio' }),
    ]);
    expect(out.history.map((h) => h.id)).toEqual(['b', 'a']);
    expect(out.priceMonth).toBe(100);
  });
});
