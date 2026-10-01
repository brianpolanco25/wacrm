import { describe, expect, it } from 'vitest';

import { buildRateCard, MetaRateMissingError } from './meta-rates';
import type { MetaPricing } from './meta-pricing';
import { buildStatement, type ChargeRow } from './statements';
import { serviceCapState } from './service-cap';
import {
  asBroadcastCategory,
  countPackage,
  currentCycle,
  directBroadcastEstimate,
  directMetaCost,
  freeTierAlert,
  managedBroadcastEstimate,
  managedUsageOf,
  packageAlert,
  percentOf,
  summarizeManaged,
  type ManagedCycle,
} from './meta-usage';

// s10.5 — the readings of the panel and of the broadcast estimate. Pure:
// synthetic `message_charges` rows and a rate card built from rows.

const RD = '18095550000';
const PRICING: MetaPricing = {
  included_messages: 7000,
  fee_usd: 1036,
  overage: {
    service: { multiplier: 2.5 },
    utility: { multiplier: 2.5 },
    marketing: { multiplier: 2.5 },
    authentication: { multiplier: 2.5 },
    authentication_international: { multiplier: 2.5 },
  },
};
const CARD = buildRateCard(
  [
    {
      market: 'rest_of_latam',
      category: 'service',
      usd_per_message: '0.01130',
      effective_from: '2026-10-01',
    },
    {
      market: 'rest_of_latam',
      category: 'utility',
      usd_per_message: '0.01130',
      effective_from: '2026-10-01',
    },
    {
      market: 'rest_of_latam',
      category: 'marketing',
      usd_per_message: '0.07400',
      effective_from: '2026-10-01',
    },
  ],
  [{ country_code: 'DO', market: 'rest_of_latam' }]
);
const NO_SERVICE_CARD = buildRateCard(
  [
    {
      market: 'rest_of_latam',
      category: 'marketing',
      usd_per_message: '0.07400',
      effective_from: '2026-10-01',
    },
  ],
  [{ country_code: 'DO', market: 'rest_of_latam' }]
);

const START = '2026-10-01T00:00:00.000Z';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const PERIOD = {
  start: START,
  cutAt: '2026-11-01T00:00:00.000Z',
  asOf: NOW.toISOString(),
};

let seq = 0;
function rows(
  n: number,
  category: string | null,
  opts: { billable?: boolean; from?: number; status?: string } = {}
): ChargeRow[] {
  const base = Date.parse('2026-10-02T00:00:00.000Z') + (opts.from ?? 0);
  return Array.from({ length: n }, (_, i) => ({
    id: `mc-${++seq}`,
    wamid: `wamid.${seq}`,
    whatsapp_config_id: 'cfg-1',
    recipient_phone: RD,
    pricing_category: category,
    pricing_billable: opts.billable ?? true,
    status: opts.status ?? 'delivered',
    delivered_at: new Date(base + i * 1000).toISOString(),
  }));
}

function cycleOf(
  charges: ChargeRow[],
  overrides: Partial<ManagedCycle> = {}
): ManagedCycle {
  return {
    period: PERIOD,
    pricing: PRICING,
    paymentMethod: 'manual',
    charges,
    rateCard: CARD,
    numbers: [
      { id: 'cfg-1', display_phone_number: '+1 809 555 0001', label: null },
    ],
    ...overrides,
  };
}

describe('percent and the 80/100 % alerts', () => {
  it('percentOf floors and clamps', () => {
    expect(percentOf(5599, 7000)).toBe(79);
    expect(percentOf(5600, 7000)).toBe(80);
    expect(percentOf(9000, 7000)).toBe(100);
    expect(percentOf(0, 0)).toBe(0);
  });

  it('the package warns at 80 % and is full at 100 %', () => {
    expect(packageAlert(5599, 7000)).toBeNull();
    expect(packageAlert(5600, 7000)).toBe('warn');
    expect(packageAlert(6999, 7000)).toBe('warn');
    expect(packageAlert(7000, 7000)).toBe('full');
    expect(packageAlert(8200, 7000)).toBe('full');
  });

  it('the free tier of a number uses p11.3’s «exhausted» for 100 %', () => {
    expect(freeTierAlert(serviceCapState({ used: 799, billable: 0 }))).toBe(
      null
    );
    expect(freeTierAlert(serviceCapState({ used: 800, billable: 0 }))).toBe(
      'warn'
    );
    expect(freeTierAlert(serviceCapState({ used: 1000, billable: 0 }))).toBe(
      'full'
    );
    // Meta already charging one is the direct proof, even under 1.000.
    expect(freeTierAlert(serviceCapState({ used: 300, billable: 1 }))).toBe(
      'full'
    );
  });
});

describe('currentCycle: the cycle in progress of a managed account', () => {
  it('anchor ahead → from the previous cut-off to the anchor', () => {
    expect(
      currentCycle({
        anchor: '2026-11-01T00:00:00.000Z',
        lastStatementEnd: '2026-10-01T00:00:00.000Z',
        now: NOW,
      })
    ).toEqual({
      start: '2026-10-01T00:00:00.000Z',
      cutAt: '2026-11-01T00:00:00.000Z',
      asOf: NOW.toISOString(),
    });
  });

  it('anchor ahead and no statement yet → anchor − 1 month', () => {
    expect(
      currentCycle({
        anchor: '2026-11-15T00:00:00.000Z',
        lastStatementEnd: null,
        now: NOW,
      }).start
    ).toBe('2026-10-15T00:00:00.000Z');
  });

  it('anchor already passed (statement waiting for payment) → the next cycle starts at it', () => {
    expect(
      currentCycle({
        anchor: '2026-10-15T00:00:00.000Z',
        lastStatementEnd: '2026-10-15T00:00:00.000Z',
        now: NOW,
      })
    ).toEqual({
      start: '2026-10-15T00:00:00.000Z',
      cutAt: '2026-11-15T00:00:00.000Z',
      asOf: NOW.toISOString(),
    });
  });

  it('no anchor → from the last statement, or a month back', () => {
    expect(
      currentCycle({ anchor: null, lastStatementEnd: null, now: NOW })
    ).toMatchObject({ start: '2026-09-20T12:00:00.000Z', cutAt: null });
    expect(
      currentCycle({
        anchor: null,
        lastStatementEnd: '2026-10-05T00:00:00.000Z',
        now: NOW,
      }).start
    ).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('«Consumo del ciclo» (managed)', () => {
  it('8.200 delivered (7.000 marketing + 1.200 service): package full, overage by category, estimate = fee + overage', () => {
    const charges = [
      ...rows(7000, 'marketing'),
      ...rows(1200, 'service', { billable: false, from: 10_000_000 }),
    ];
    const usage = managedUsageOf('acct-a', cycleOf(charges));
    expect(usage).toMatchObject({
      state: 'ok',
      includedMessages: 7000,
      packageUsed: 7000,
      overageMessages: 1200,
      percent: 100,
      alert: 'full',
      feeUsd: 1036,
      overageUsd: 33.9,
      estimatedTotalUsd: 1069.9,
      dueAtCutUsd: 1069.9,
    });
    expect(usage.overageByCategory).toEqual([
      {
        category: 'service',
        messages: 1200,
        unitPriceUsd: 0.02825,
        chargeUsd: 33.9,
      },
    ]);
  });

  it('is the same figure buildStatement gives for the period (no second count)', () => {
    const charges = [...rows(7500, 'marketing')];
    const end = new Date(NOW.getTime() + 1).toISOString();
    const built = buildStatement('acct-a', START, end, {
      charges,
      rateCard: CARD,
      pricing: PRICING,
      paymentMethod: 'manual',
    });
    const usage = managedUsageOf('acct-a', cycleOf(charges));
    expect(usage.overageUsd).toBe(built.usage_charge_usd);
    expect(usage.dueAtCutUsd).toBe(built.total_usd);
    // 500 × 0,0740 × 2,5 = 92,50
    expect(usage.overageUsd).toBe(92.5);
  });

  it('warns at 80 % of the package with no overage', () => {
    const usage = managedUsageOf('acct-a', cycleOf(rows(5600, 'marketing')));
    expect(usage).toMatchObject({
      alert: 'warn',
      percent: 80,
      overageMessages: 0,
      overageUsd: 0,
      estimatedTotalUsd: 1036,
    });
  });

  it('counts only delivered messages with a category, inside the cycle', () => {
    const charges = [
      ...rows(900, 'marketing'),
      ...rows(100, 'marketing', { status: 'failed' }).map((r) => ({
        ...r,
        delivered_at: null,
      })),
      ...rows(3, null),
      // Before the cycle: belongs to the previous statement.
      ...rows(50, 'marketing').map((r) => ({
        ...r,
        delivered_at: '2026-09-30T23:00:00.000Z',
      })),
    ];
    const usage = managedUsageOf('acct-a', cycleOf(charges));
    expect(usage.packageUsed).toBe(900);
    expect(usage.uncategorized).toBe(3);
  });

  it('PayPal: the estimate is fee + overage, and what is billed at the cut-off is the overage alone', () => {
    const usage = managedUsageOf(
      'acct-a',
      cycleOf(rows(7100, 'marketing'), { paymentMethod: 'paypal' })
    );
    expect(usage.estimatedTotalUsd).toBe(1036 + 18.5);
    expect(usage.dueAtCutUsd).toBe(18.5);
  });

  it('never carries what is internal: no billable mark, no Meta rate, no real cost', () => {
    const text = JSON.stringify(
      managedUsageOf('acct-a', cycleOf(rows(7100, 'marketing')))
    );
    for (const secret of ['billable', 'meta_rate', 'meta_cost', 'metaCost']) {
      expect(text).not.toContain(secret);
    }
  });

  it('a missing rate (MetaRateMissingError) is «tarifa pendiente»: the package is still counted, no amounts', () => {
    const charges = [
      ...rows(6900, 'marketing'),
      ...rows(200, 'service', { from: 10_000_000 }),
    ];
    const usage = managedUsageOf(
      'acct-a',
      cycleOf(charges, { rateCard: NO_SERVICE_CARD })
    );
    expect(usage).toMatchObject({
      state: 'rate_pending',
      packageUsed: 7000,
      overageMessages: 100,
      alert: 'full',
      overageUsd: null,
      estimatedTotalUsd: null,
      dueAtCutUsd: null,
      missingRate: { market: 'rest_of_latam', category: 'service' },
    });
    expect(usage.overageByCategory).toEqual([
      {
        category: 'service',
        messages: 100,
        unitPriceUsd: null,
        chargeUsd: null,
      },
    ]);
  });

  it('an account without a valid price policy says so instead of failing', () => {
    const usage = managedUsageOf('acct-a', cycleOf([], { pricing: null }));
    expect(usage.state).toBe('pricing_missing');
  });

  it('summarizeManaged leaves out lines with no overage', () => {
    const end = new Date(NOW.getTime() + 1).toISOString();
    const built = buildStatement('acct-a', START, end, {
      charges: rows(10, 'marketing'),
      rateCard: CARD,
      pricing: PRICING,
      paymentMethod: 'manual',
    });
    expect(
      summarizeManaged(built, {
        pricing: PRICING,
        paymentMethod: 'manual',
        period: PERIOD,
      }).overageByCategory
    ).toEqual([]);
  });

  it('countPackage fills the package in delivery order', () => {
    const charges = [
      ...rows(2, 'service', { from: 5_000_000 }),
      ...rows(2, 'marketing'),
    ];
    const counted = countPackage(
      charges,
      { ...PRICING, included_messages: 2 },
      PERIOD
    );
    expect(counted.overageByCategory).toEqual([
      { category: 'service', messages: 2, unitPriceUsd: null, chargeUsd: null },
    ]);
  });
});

describe('what Meta will charge a direct account', () => {
  it('only the billable deliveries, at Meta’s rate, without multiplier', () => {
    const charges = [
      ...rows(1000, 'service', { billable: false }),
      ...rows(20, 'service', { from: 5_000_000 }),
      ...rows(100, 'marketing', { from: 6_000_000 }),
      ...rows(5, 'marketing', { billable: false, from: 7_000_000 }),
    ];
    const cost = directMetaCost(
      charges,
      CARD,
      START,
      '2026-11-01T00:00:00.000Z'
    );
    // 100 × 0,074 + 20 × 0,0113 = 7,40 + 0,226
    expect(cost.totalUsd).toBe(7.63);
    expect(cost.byCategory).toEqual([
      { category: 'marketing', billable: 100, costUsd: 7.4 },
      { category: 'service', billable: 20, costUsd: 0.23 },
    ]);
  });

  it('throws MetaRateMissingError rather than price a message at 0', () => {
    expect(() =>
      directMetaCost(
        rows(1, 'service'),
        NO_SERVICE_CARD,
        START,
        '2026-11-01T00:00:00.000Z'
      )
    ).toThrow(MetaRateMissingError);
  });
});

describe('broadcast estimate', () => {
  it('direct: {n} recipients × Meta’s marketing rate', () => {
    expect(
      directBroadcastEstimate({
        recipients: 1000,
        category: 'marketing',
        market: 'rest_of_latam',
        rateUsd: 0.074,
      })
    ).toMatchObject({ ratePending: false, unitUsd: 0.074, totalUsd: 74 });
  });

  it('direct with no rate loaded: pending, no figure', () => {
    expect(
      directBroadcastEstimate({
        recipients: 1000,
        category: 'marketing',
        market: 'rest_of_world',
        rateUsd: null,
      })
    ).toMatchObject({ ratePending: true, totalUsd: null });
  });

  it('managed: the first ones fill what is left of the package, the rest is overage at the account’s price', () => {
    expect(
      managedBroadcastEstimate({
        recipients: 1000,
        category: 'marketing',
        market: 'rest_of_latam',
        remaining: 500,
        unitPriceUsd: 0.185,
      })
    ).toMatchObject({
      inPackage: 500,
      overage: 500,
      overageUsd: 92.5,
      ratePending: false,
    });
  });

  it('managed with the package already spent: everything is overage', () => {
    expect(
      managedBroadcastEstimate({
        recipients: 10,
        category: 'marketing',
        market: null,
        remaining: -200,
        unitPriceUsd: 0.185,
      })
    ).toMatchObject({ remaining: 0, inPackage: 0, overage: 10 });
  });

  it('managed inside the package: no overage', () => {
    expect(
      managedBroadcastEstimate({
        recipients: 10,
        category: 'marketing',
        market: null,
        remaining: 5000,
        unitPriceUsd: null,
      })
    ).toMatchObject({ inPackage: 10, overage: 0 });
  });

  it('the template category: Marketing / UTILITY / anything else → marketing', () => {
    expect(asBroadcastCategory('Marketing')).toBe('marketing');
    expect(asBroadcastCategory('UTILITY')).toBe('utility');
    expect(asBroadcastCategory('authentication')).toBe('authentication');
    expect(asBroadcastCategory('service')).toBe('marketing');
    expect(asBroadcastCategory(undefined)).toBe('marketing');
  });
});
