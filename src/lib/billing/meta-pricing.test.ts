import { describe, expect, it } from 'vitest';

import {
  MetaPriceMissingError,
  packageCharge,
  parseMetaPricing,
  priceFor,
  type MetaPricing,
  type PackageDelivery,
} from './meta-pricing';
import { META_CATEGORIES } from './meta-rates';

// s10.2: the price policy of a managed account (`meta_pricing`).

/** The policy of the `gestionado` plan, exactly as the spec writes it. */
const GESTIONADO = {
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

const MARKETING_RD = 0.074;
const SERVICE_RD = 0.0113;

function policy(): MetaPricing {
  const parsed = parseMetaPricing(GESTIONADO);
  if (!parsed.ok || !parsed.value) throw new Error('fixture');
  return parsed.value;
}

function marketing(n: number): PackageDelivery[] {
  return Array.from({ length: n }, () => ({
    category: 'marketing' as const,
    metaRate: MARKETING_RD,
  }));
}

describe('parseMetaPricing', () => {
  it('accepts the policy of the gestionado plan', () => {
    expect(parseMetaPricing(GESTIONADO)).toEqual({
      ok: true,
      value: GESTIONADO,
    });
  });

  it('reads {} as a direct account: valid, no price', () => {
    expect(parseMetaPricing({})).toEqual({ ok: true, value: null });
  });

  it('accepts a fixed usd_per_message, alone or next to a multiplier', () => {
    const parsed = parseMetaPricing({
      ...GESTIONADO,
      overage: {
        ...GESTIONADO.overage,
        utility: { usd_per_message: 0.03 },
        marketing: { multiplier: 2.5, usd_per_message: 0.2 },
      },
    });
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ['not an object', [1, 2]],
    ['null', null],
    ['an unknown field', { ...GESTIONADO, deposit: 100 }],
    ['negative included messages', { ...GESTIONADO, included_messages: -1 }],
    [
      'fractional included messages',
      { ...GESTIONADO, included_messages: 7000.5 },
    ],
    ['a fee with three decimals', { ...GESTIONADO, fee_usd: 1036.001 }],
    ['a fee as a string', { ...GESTIONADO, fee_usd: '1036' }],
    ['no overage', { included_messages: 7000, fee_usd: 1036 }],
    [
      'a missing category',
      {
        ...GESTIONADO,
        overage: { ...GESTIONADO.overage, authentication: undefined },
      },
    ],
    [
      'an unknown category',
      {
        ...GESTIONADO,
        overage: { ...GESTIONADO.overage, sms: { multiplier: 1 } },
      },
    ],
    [
      'a category with neither price',
      { ...GESTIONADO, overage: { ...GESTIONADO.overage, service: {} } },
    ],
    [
      'a zero multiplier',
      {
        ...GESTIONADO,
        overage: { ...GESTIONADO.overage, service: { multiplier: 0 } },
      },
    ],
    [
      'a zero fixed price',
      {
        ...GESTIONADO,
        overage: { ...GESTIONADO.overage, service: { usd_per_message: 0 } },
      },
    ],
    [
      'an unknown key in a category',
      {
        ...GESTIONADO,
        overage: { ...GESTIONADO.overage, service: { multiplier: 2, cap: 1 } },
      },
    ],
  ])('refuses %s', (_label, value) => {
    // JSON round-trip: `undefined` disappears, like in the database.
    const raw = value === undefined ? value : JSON.parse(JSON.stringify(value));
    expect(parseMetaPricing(raw).ok).toBe(false);
  });

  it('requires every category of the inventory', () => {
    for (const category of META_CATEGORIES) {
      const overage = { ...GESTIONADO.overage } as Record<string, unknown>;
      delete overage[category];
      const parsed = parseMetaPricing({ ...GESTIONADO, overage });
      expect(parsed).toEqual({
        ok: false,
        error: `overage '${category}' is required`,
      });
    }
  });
});

describe('priceFor', () => {
  it('multiplies Meta’s rate: marketing in RD × 2,5 = 0,185', () => {
    expect(priceFor(policy(), 'marketing', MARKETING_RD)).toBeCloseTo(
      0.185,
      10
    );
  });

  it('the fixed amount wins over the multiplier', () => {
    const p = policy();
    p.overage.marketing = { multiplier: 2.5, usd_per_message: 0.2 };
    expect(priceFor(p, 'marketing', MARKETING_RD)).toBe(0.2);
    // …even with no usable Meta rate: the fixed price does not need it.
    expect(priceFor(p, 'marketing', Number.NaN)).toBe(0.2);
  });

  it('refuses to price with a Meta rate of 0 or NaN (never 0)', () => {
    expect(() => priceFor(policy(), 'marketing', 0)).toThrow(RangeError);
    expect(() => priceFor(policy(), 'marketing', Number.NaN)).toThrow(
      RangeError
    );
  });

  it('throws for a category with no price', () => {
    const p = policy();
    delete (p.overage as Record<string, unknown>).service;
    expect(() => priceFor(p, 'service', SERVICE_RD)).toThrow(
      MetaPriceMissingError
    );
  });
});

describe('packageCharge — the examples of the spec', () => {
  it('4.000 marketing deliveries → exactly the fee, 1.036', () => {
    const charge = packageCharge(policy(), marketing(4000));
    expect(charge).toEqual({
      feeUsd: 1036,
      includedMessages: 7000,
      includedUsed: 4000,
      overageMessages: 0,
      overageUsd: 0,
      totalUsd: 1036,
    });
  });

  it('9.000 marketing deliveries → 1.036 + 2.000 × 0,0740 × 2,5 = 1.406', () => {
    const charge = packageCharge(policy(), marketing(9000));
    expect(charge.overageMessages).toBe(2000);
    expect(charge.overageUsd).toBe(370);
    expect(charge.totalUsd).toBe(1406);
    // What Meta charged Cabbity for those 9.000: 666 USD.
    expect(Math.round(9000 * MARKETING_RD * 100) / 100).toBe(666);
  });

  it('prices the overage in delivery order, each at its own category', () => {
    // 7.000 marketing fill the package; 1.200 service go to overage.
    const deliveries = [
      ...marketing(7000),
      ...Array.from({ length: 1200 }, () => ({
        category: 'service' as const,
        metaRate: SERVICE_RD,
      })),
    ];
    const charge = packageCharge(policy(), deliveries);
    expect(charge.overageMessages).toBe(1200);
    expect(charge.overageUsd).toBe(33.9); // 1.200 × 2,5 × 0,0113
    expect(charge.totalUsd).toBe(1069.9);
  });

  it('a fixed per-message price changes the overage without a migration', () => {
    const p = policy();
    p.overage.marketing = { usd_per_message: 0.15 };
    expect(packageCharge(p, marketing(9000)).totalUsd).toBe(1336);
  });
});
