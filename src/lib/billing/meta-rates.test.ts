import { describe, expect, it } from 'vitest';

import {
  buildRateCard,
  loadRateCard,
  MetaRateMissingError,
  rateForPhone,
  REST_OF_WORLD,
  utcDay,
  type MarketCountryRow,
  type MetaRateRow,
} from './meta-rates';
import { FakeDatabase } from '@/lib/security/fake-supabase';

// s10.2: `rateFor(countryCode, category, at)`. Synthetic rows; the seed
// of 076 is checked against the real database in
// progress/checks_meta-rate-card.sql.

const SEED_RATES: MetaRateRow[] = [
  // What PostgREST returns for numeric(8,5): strings.
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
];

const COUNTRIES: MarketCountryRow[] = [
  { country_code: 'DO', market: 'rest_of_latam' },
  { country_code: 'GT', market: 'rest_of_latam' },
  { country_code: 'MX', market: 'mexico' },
];

describe('rateFor', () => {
  const card = buildRateCard(SEED_RATES, COUNTRIES);

  it('prices a marketing message to the Dominican Republic at 0,0740 from 2026-10-01', () => {
    expect(card.rateFor('DO', 'marketing', '2026-10-01T00:00:00Z')).toEqual({
      market: 'rest_of_latam',
      category: 'marketing',
      usdPerMessage: 0.074,
      effectiveFrom: '2026-10-01',
    });
    expect(
      card.rateFor('do', 'service', new Date('2026-10-15T12:00:00Z'))
        .usdPerMessage
    ).toBe(0.0113);
    expect(card.rateFor('GT', 'utility', '2026-11-30').usdPerMessage).toBe(
      0.0113
    );
  });

  it('uses the latest effective_from that is not after the UTC day of delivery', () => {
    const later = buildRateCard(
      [
        ...SEED_RATES,
        {
          market: 'rest_of_latam',
          category: 'marketing',
          usd_per_message: 0.08,
          effective_from: '2027-01-01',
        },
      ],
      COUNTRIES
    );
    expect(
      later.rateFor('DO', 'marketing', '2026-12-31T23:59:59Z').usdPerMessage
    ).toBe(0.074);
    expect(
      later.rateFor('DO', 'marketing', '2027-01-01T00:00:00Z').usdPerMessage
    ).toBe(0.08);
    // 2026-12-31 20:30 in Santo Domingo is already 2027-01-01 in UTC.
    expect(
      later.rateFor('DO', 'marketing', '2027-01-01T00:30:00-04:00')
        .usdPerMessage
    ).toBe(0.08);
  });

  it('throws before the first effective date instead of answering 0', () => {
    expect(() =>
      card.rateFor('DO', 'marketing', '2026-09-30T23:59:59Z')
    ).toThrow(MetaRateMissingError);
  });

  it('throws for a category the market has no rate for (authentication is not in the seed)', () => {
    let error: unknown;
    try {
      card.rateFor('DO', 'authentication', '2026-10-02');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MetaRateMissingError);
    expect((error as MetaRateMissingError).market).toBe('rest_of_latam');
    expect((error as MetaRateMissingError).category).toBe('authentication');
    expect((error as Error).message).toContain('/platform/rates');
  });

  it('never borrows another market: a known market without rates throws, even when rest_of_world has one', () => {
    const withWorld = buildRateCard(
      [
        ...SEED_RATES,
        {
          market: REST_OF_WORLD,
          category: 'marketing',
          usd_per_message: 0.05,
          effective_from: '2026-10-01',
        },
      ],
      COUNTRIES
    );
    expect(() => withWorld.rateFor('MX', 'marketing', '2026-10-02')).toThrow(
      /market 'mexico'/
    );
  });

  it('sends an unknown country to rest_of_world when that market has a rate', () => {
    const withWorld = buildRateCard(
      [
        ...SEED_RATES,
        {
          market: REST_OF_WORLD,
          category: 'marketing',
          usd_per_message: '0.05000',
          effective_from: '2026-10-01',
        },
      ],
      COUNTRIES
    );
    expect(withWorld.rateFor('ZZ', 'marketing', '2026-10-02')).toMatchObject({
      market: REST_OF_WORLD,
      usdPerMessage: 0.05,
    });
    expect(withWorld.rateFor(null, 'marketing', '2026-10-02').market).toBe(
      REST_OF_WORLD
    );
  });

  it('throws for an unknown country when rest_of_world has no rate either (never 0)', () => {
    expect(() => card.rateFor('ZZ', 'marketing', '2026-10-02')).toThrow(
      /market 'rest_of_world'/
    );
    expect(() => card.rateFor(undefined, 'service', '2026-10-02')).toThrow(
      MetaRateMissingError
    );
  });

  it('skips a row with a rate of 0 or garbage instead of pricing with it', () => {
    const broken = buildRateCard(
      [
        {
          market: 'rest_of_latam',
          category: 'marketing',
          usd_per_message: 0,
          effective_from: '2026-10-01',
        },
        {
          market: 'rest_of_latam',
          category: 'utility',
          usd_per_message: 'abc',
          effective_from: '2026-10-01',
        },
      ],
      COUNTRIES
    );
    expect(() => broken.rateFor('DO', 'marketing', '2026-10-02')).toThrow(
      MetaRateMissingError
    );
    expect(() => broken.rateFor('DO', 'utility', '2026-10-02')).toThrow(
      MetaRateMissingError
    );
  });

  it('rejects an invalid date', () => {
    expect(() => card.rateFor('DO', 'marketing', 'not a date')).toThrow(
      RangeError
    );
  });
});

describe('rateForPhone', () => {
  it('resolves the recipient country from the number (+1 809 is RD, not the US)', () => {
    const card = buildRateCard(SEED_RATES, COUNTRIES);
    expect(
      rateForPhone(card, '+1 809 555 0100', 'marketing', '2026-10-02')
    ).toMatchObject({ market: 'rest_of_latam', usdPerMessage: 0.074 });
    expect(() =>
      rateForPhone(card, '+1 415 555 1212', 'marketing', '2026-10-02')
    ).toThrow(MetaRateMissingError);
  });
});

describe('utcDay', () => {
  it('keeps a plain day and converts an instant to its UTC day', () => {
    expect(utcDay('2026-10-01')).toBe('2026-10-01');
    expect(utcDay('2026-09-30T22:00:00-04:00')).toBe('2026-10-01');
  });
});

describe('loadRateCard', () => {
  it('builds the card from both tables', async () => {
    const db = new FakeDatabase({
      meta_rates: SEED_RATES.map((r) => ({ ...r })),
      meta_market_countries: COUNTRIES.map((r) => ({ ...r })),
    });
    const card = await loadRateCard(db.admin as never);
    expect(card.rateFor('DO', 'marketing', '2026-10-05').usdPerMessage).toBe(
      0.074
    );
    expect(card.marketFor('MX')).toBe('mexico');
  });
});
