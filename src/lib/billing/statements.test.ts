import { describe, expect, it } from 'vitest';

import { buildRateCard, MetaRateMissingError } from './meta-rates';
import type { MetaPricing } from './meta-pricing';
import {
  buildStatement,
  customerStatement,
  effectivePaymentMethod,
  nextPeriodEnd,
  statementCategory,
  statementDueAt,
  statementPeriodStart,
  subtractMonth,
  type ChargeRow,
  type StatementInputs,
  type StatementRow,
} from './statements';

// s10.4 — the statement at the cut-off, on synthetic rows. The numbers
// are the checkpoints of the spec («Checkpoints propios»): marketing in
// RD at 0,0740, service and utility at 0,0113, 7.000 included, fee 1.036,
// ×2,5 overage.

const ACCOUNT = 'acct-a';
const START = '2026-10-01T00:00:00.000Z';
const END = '2026-11-01T00:00:00.000Z';
const RD_PHONE = '18095550000';
const MX_PHONE = '5215550000000';

const RATES = buildRateCard(
  [
    {
      market: 'rest_of_latam',
      category: 'marketing',
      usd_per_message: '0.07400',
      effective_from: '2026-10-01',
    },
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
  ],
  [
    { country_code: 'DO', market: 'rest_of_latam' },
    { country_code: 'MX', market: 'mexico' },
  ]
);

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

let seq = 0;
/** `count` deliveries one second apart from `fromMs`. */
function rows(
  count: number,
  opts: {
    category?: string | null;
    billable?: boolean | null;
    fromMs?: number;
    status?: string;
    phone?: string;
    number?: string | null;
    delivered?: boolean;
  } = {}
): ChargeRow[] {
  const from = opts.fromMs ?? Date.parse('2026-10-02T00:00:00.000Z');
  return Array.from({ length: count }, (_, i) => {
    seq += 1;
    const delivered = opts.delivered ?? true;
    return {
      id: `c-${String(seq).padStart(6, '0')}`,
      account_id: ACCOUNT,
      wamid: `wamid.${String(seq).padStart(6, '0')}`,
      whatsapp_config_id: opts.number === undefined ? 'num-1' : opts.number,
      recipient_phone: opts.phone ?? RD_PHONE,
      pricing_category:
        opts.category === undefined ? 'marketing' : opts.category,
      pricing_billable: opts.billable === undefined ? true : opts.billable,
      status: opts.status ?? (delivered ? 'delivered' : 'failed'),
      delivered_at: delivered ? new Date(from + i * 1000).toISOString() : null,
    };
  });
}

function inputs(
  charges: ChargeRow[],
  over: Partial<StatementInputs> = {}
): StatementInputs {
  return {
    charges,
    rateCard: RATES,
    pricing: PRICING,
    paymentMethod: 'manual',
    numbers: [
      { id: 'num-1', display_phone_number: '+1 809 555 0001', label: null },
      { id: 'num-2', display_phone_number: null, label: 'Ventas' },
    ],
    ...over,
  };
}

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-10-02T00:00:00.000Z');

describe('buildStatement — the checkpoints of the spec', () => {
  it('8.200 delivered (7.000 marketing + 1.200 service, 200 billable): 1.036 + 1.200 × 2,5 × 0,0113, and the real cost is only the billable', () => {
    const marketing = rows(7000, { category: 'marketing', fromMs: T0 });
    const serviceBillable = rows(200, {
      category: 'service',
      billable: true,
      fromMs: T0 + 10 * DAY,
    });
    const serviceFree = rows(1000, {
      category: 'service',
      billable: false,
      fromMs: T0 + 11 * DAY,
    });

    const s = buildStatement(
      ACCOUNT,
      START,
      END,
      inputs([...serviceFree, ...marketing, ...serviceBillable])
    );

    const overage = 1200 * 2.5 * 0.0113; // 33,90
    expect(s.messages_total).toBe(8200);
    expect(s.overage_messages).toBe(1200);
    expect(s.included_messages).toBe(7000);
    expect(s.plan_fee_usd).toBe(1036);
    expect(s.usage_charge_usd).toBeCloseTo(overage, 2);
    expect(s.usage_charge_usd).toBe(33.9);
    expect(s.total_usd).toBe(1069.9);
    // Meta charged the 7.000 marketing and 200 of the service messages.
    expect(s.meta_cost_usd).toBe(
      Math.round((7000 * 0.074 + 200 * 0.0113) * 100) / 100
    );
    expect(s.meta_cost_usd).toBe(520.26);

    const service = s.usage.lines.find((l) => l.category === 'service')!;
    expect(service).toMatchObject({
      delivered: 1200,
      billable: 200,
      included: 0,
      overage: 1200,
      meta_rate_usd: 0.0113,
      unit_price_usd: 0.02825,
      charge_usd: 33.9,
      meta_cost_usd: 2.26,
      number: '+1 809 555 0001',
    });
    const mkt = s.usage.lines.find((l) => l.category === 'marketing')!;
    expect(mkt).toMatchObject({
      delivered: 7000,
      billable: 7000,
      included: 7000,
      overage: 0,
      charge_usd: 0,
    });
  });

  it('a broadcast of 1.000 marketing with 900 delivered and 100 failed adds 900 to the package', () => {
    const delivered = rows(900, { fromMs: T0 });
    const failed = rows(100, { delivered: false });
    const sentOnly = rows(5, { delivered: false, status: 'sent' });

    const s = buildStatement(
      ACCOUNT,
      START,
      END,
      inputs([...delivered, ...failed, ...sentOnly])
    );

    expect(s.messages_total).toBe(900);
    expect(s.usage.package_used).toBe(900);
    expect(s.overage_messages).toBe(0);
    expect(s.total_usd).toBe(1036);
  });

  it('a month with 4.000 delivered bills exactly the fee', () => {
    const s = buildStatement(ACCOUNT, START, END, inputs(rows(4000)));
    expect(s.total_usd).toBe(1036);
    expect(s.plan_fee_usd).toBe(1036);
    expect(s.usage_charge_usd).toBe(0);
    expect(s.overage_messages).toBe(0);
  });

  it('with PayPal the fee is PayPal’s: 4.000 delivered is a statement of 0', () => {
    const s = buildStatement(
      ACCOUNT,
      START,
      END,
      inputs(rows(4000), { paymentMethod: 'paypal' })
    );
    expect(s.plan_fee_usd).toBe(0);
    expect(s.usage_charge_usd).toBe(0);
    expect(s.total_usd).toBe(0);
  });

  it('with PayPal the total is the overage alone (9.000 marketing → 2.000 × 0,0740 × 2,5 = 370)', () => {
    const s = buildStatement(
      ACCOUNT,
      START,
      END,
      inputs(rows(9000), { paymentMethod: 'paypal' })
    );
    expect(s.plan_fee_usd).toBe(0);
    expect(s.usage_charge_usd).toBe(370);
    expect(s.total_usd).toBe(370);
  });

  it('the spec example: 9.000 marketing → 1.036 + 2.000 × 0,0740 × 2,5 = 1.406 (Meta charged 666)', () => {
    const s = buildStatement(ACCOUNT, START, END, inputs(rows(9000)));
    expect(s.total_usd).toBe(1406);
    expect(s.meta_cost_usd).toBe(666);
  });

  it('the package runs out halfway through a broadcast: only the deliveries after that point are overage', () => {
    const earlier = rows(6500, {
      category: 'service',
      billable: false,
      fromMs: T0,
    });
    const broadcast = rows(1000, {
      category: 'marketing',
      fromMs: T0 + 5 * DAY,
      number: 'num-2',
    });
    // Order of the input must not matter: the rule is the order of delivery.
    const shuffled = [
      ...broadcast.slice(500),
      ...earlier,
      ...broadcast.slice(0, 500),
    ];

    const s = buildStatement(ACCOUNT, START, END, inputs(shuffled));

    expect(s.messages_total).toBe(7500);
    expect(s.overage_messages).toBe(500);
    const mkt = s.usage.lines.find((l) => l.category === 'marketing')!;
    expect(mkt).toMatchObject({
      included: 500,
      overage: 500,
      number: 'Ventas',
    });
    expect(s.usage_charge_usd).toBe(92.5); // 500 × 0,0740 × 2,5
    expect(s.total_usd).toBe(1128.5);

    // The very same deliveries, the other way round (marketing first):
    // now the service messages are the overage.
    const reversed = [
      ...rows(1000, { category: 'marketing', fromMs: T0 }),
      ...rows(6500, {
        category: 'service',
        billable: false,
        fromMs: T0 + 5 * DAY,
      }),
    ];
    const r = buildStatement(ACCOUNT, START, END, inputs(reversed));
    expect(r.usage_charge_usd).toBe(Math.round(500 * 0.0113 * 2.5 * 100) / 100);
  });

  it('a missing rate fails the WHOLE statement with MetaRateMissingError — nothing partial', () => {
    const charges = [...rows(10), ...rows(1, { phone: MX_PHONE })];
    expect(() => buildStatement(ACCOUNT, START, END, inputs(charges))).toThrow(
      MetaRateMissingError
    );
    // Inside the package too: the rate is what a billable one costs.
    expect(() =>
      buildStatement(ACCOUNT, START, END, inputs(rows(1, { phone: MX_PHONE })))
    ).toThrow(MetaRateMissingError);
  });

  it('no rate resolves to 0 for an unknown market (no rest_of_world rate → error)', () => {
    // +999: no country, so the market is rest_of_world, which has no rate.
    expect(() =>
      buildStatement(
        ACCOUNT,
        START,
        END,
        inputs(rows(1, { phone: '9991234567' }))
      )
    ).toThrow(MetaRateMissingError);
  });

  it('a delivered message without a Meta category is never billed, and the statement says how many there were', () => {
    const charges = [
      ...rows(7000),
      ...rows(3, { category: null, fromMs: T0 + DAY }),
      ...rows(2, { category: 'marketing_lite', fromMs: T0 + DAY }),
      ...rows(1, { category: '  ', fromMs: T0 + DAY }),
    ];
    const s = buildStatement(ACCOUNT, START, END, inputs(charges));

    expect(s.messages_total).toBe(7000);
    expect(s.overage_messages).toBe(0);
    expect(s.total_usd).toBe(1036);
    expect(s.usage.uncategorized).toEqual({
      total: 6,
      by_category: { '(none)': 4, marketing_lite: 2 },
    });
  });

  it('a category Meta writes with a dash is the one in the price list', () => {
    expect(statementCategory('authentication-international')).toBe(
      'authentication_international'
    );
    expect(statementCategory(' Marketing ')).toBe('marketing');
    expect(statementCategory('marketing_lite')).toBeNull();
    expect(statementCategory(null)).toBeNull();
  });
});

describe('buildStatement — the edges', () => {
  it('counts [start, end): a delivery at the cut-off belongs to the next period; a read one counts', () => {
    const atStart = rows(1, { fromMs: Date.parse(START) });
    const atEnd = rows(1, { fromMs: Date.parse(END) });
    const before = rows(1, { fromMs: Date.parse(START) - 1 });
    const read = rows(1, { status: 'read' });
    const s = buildStatement(
      ACCOUNT,
      START,
      END,
      inputs([...atStart, ...atEnd, ...before, ...read])
    );
    expect(s.messages_total).toBe(2);
  });

  it('never counts a row of another account, even if one slipped in', () => {
    const foreign = rows(5).map((r) => ({ ...r, account_id: 'acct-b' }));
    const s = buildStatement(
      ACCOUNT,
      START,
      END,
      inputs([...rows(2), ...foreign])
    );
    expect(s.messages_total).toBe(2);
  });

  it('a fixed price per message wins over the multiplier', () => {
    const pricing: MetaPricing = {
      ...PRICING,
      included_messages: 0,
      overage: { ...PRICING.overage, marketing: { usd_per_message: 0.15 } },
    };
    const s = buildStatement(
      ACCOUNT,
      START,
      END,
      inputs(rows(10), { pricing })
    );
    expect(s.usage_charge_usd).toBe(1.5);
    expect(s.usage.lines[0].unit_price_usd).toBe(0.15);
  });

  it('an empty month is the fee alone', () => {
    const s = buildStatement(ACCOUNT, START, END, inputs([]));
    expect(s).toMatchObject({
      total_usd: 1036,
      messages_total: 0,
      meta_cost_usd: 0,
    });
    expect(s.usage.lines).toEqual([]);
  });

  it('refuses a period that ends before it starts', () => {
    expect(() => buildStatement(ACCOUNT, END, START, inputs([]))).toThrow(
      RangeError
    );
  });
});

describe('periods', () => {
  it('the due date is the cut-off plus three days', () => {
    expect(statementDueAt(END)).toBe('2026-11-04T00:00:00.000Z');
  });

  it('confirming late does not move the cut-off: the next period ends a month after the previous one', () => {
    // Cut-off on the 1st of November, paid on the 20th: the next cut-off
    // is still the 1st of December.
    expect(nextPeriodEnd(END, END)).toBe('2026-12-01T00:00:00.000Z');
    // A PayPal renewal that already pushed the end further is kept.
    expect(nextPeriodEnd(END, '2026-12-03T10:00:00.000Z')).toBe(
      '2026-12-03T10:00:00.000Z'
    );
    // The month clamps like PayPal’s: 31 January → 28 February.
    expect(nextPeriodEnd('2027-01-31T12:00:00.000Z', null)).toBe(
      '2027-02-28T12:00:00.000Z'
    );
  });

  it('the period starts where the previous statement ended, never more than a month back', () => {
    expect(statementPeriodStart(END, null)).toBe(START);
    expect(statementPeriodStart(END, '2026-10-03T00:00:00.000Z')).toBe(
      '2026-10-03T00:00:00.000Z'
    );
    // A statement from months ago (PayPal months without overage in
    // between) does not stretch the period.
    expect(statementPeriodStart(END, '2026-07-01T00:00:00.000Z')).toBe(START);
    expect(subtractMonth('2026-03-31T00:00:00.000Z')).toBe(
      '2026-02-28T00:00:00.000Z'
    );
  });

  it('the payment method falls back to the provider', () => {
    expect(effectivePaymentMethod('paypal', 'manual')).toBe('paypal');
    expect(effectivePaymentMethod(null, 'paypal')).toBe('paypal');
    expect(effectivePaymentMethod(null, 'manual')).toBe('manual');
    expect(effectivePaymentMethod(undefined, null)).toBe('manual');
  });
});

describe('customerStatement — what the customer sees', () => {
  it('never carries billable, the Meta rate, the real cost or the payment data', () => {
    const built = buildStatement(
      ACCOUNT,
      START,
      END,
      inputs([
        ...rows(7000),
        ...rows(10, { category: 'service', fromMs: T0 + DAY }),
      ])
    );
    const row: StatementRow = {
      id: 'st-1',
      ...built,
      status: 'issued',
      issued_at: END,
      due_at: statementDueAt(END),
      paid_at: null,
      paid_by: 'op-1',
      paid_reference: 'TRX-SECRET',
      paid_note: 'internal note',
    };
    const view = customerStatement(row);
    const text = JSON.stringify(view);

    expect(view).toMatchObject({
      id: 'st-1',
      totalUsd: built.total_usd,
      planFeeUsd: 1036,
      messagesTotal: 7010,
      overageMessages: 10,
    });
    expect(view.lines.find((l) => l.category === 'service')).toEqual({
      number: '+1 809 555 0001',
      category: 'service',
      delivered: 10,
      included: 0,
      overage: 10,
      unitPriceUsd: 0.02825,
      chargeUsd: 0.28,
    });
    for (const secret of [
      'billable',
      'meta_rate',
      'meta_cost',
      'metaCost',
      'TRX-SECRET',
      'internal note',
      'op-1',
      '"market"',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
