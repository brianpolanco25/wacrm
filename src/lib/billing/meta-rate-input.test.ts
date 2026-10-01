import { describe, expect, it } from 'vitest';

import {
  classifyRate,
  IMPORT_MAX_ROWS,
  previewRateImport,
  validateMarketEntries,
  validateRateInput,
  type ExistingRate,
} from './meta-rate-input';

// s10.2: what /platform/rates may write. A rate in force is never edited.

const EXISTING: ExistingRate[] = [
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
];
const TODAY = '2026-11-15';

describe('validateRateInput', () => {
  it('normalises market and category, accepts a numeric string', () => {
    expect(
      validateRateInput({
        market: ' Rest_Of_Latam ',
        category: 'MARKETING',
        usd_per_message: '0.0740',
        effective_from: '2027-01-01',
      })
    ).toEqual({
      ok: true,
      value: {
        market: 'rest_of_latam',
        category: 'marketing',
        usd_per_message: 0.074,
        effective_from: '2027-01-01',
      },
    });
  });

  it.each([
    ['not an object', 'x'],
    [
      'an unknown field',
      {
        market: 'mexico',
        category: 'marketing',
        usd_per_message: 0.1,
        effective_from: '2027-01-01',
        note: 'x',
      },
    ],
    [
      'a market with spaces',
      {
        market: 'rest of latam',
        category: 'marketing',
        usd_per_message: 0.1,
        effective_from: '2027-01-01',
      },
    ],
    [
      'an unknown category',
      {
        market: 'mexico',
        category: 'sms',
        usd_per_message: 0.1,
        effective_from: '2027-01-01',
      },
    ],
    [
      'a rate of 0',
      {
        market: 'mexico',
        category: 'marketing',
        usd_per_message: 0,
        effective_from: '2027-01-01',
      },
    ],
    [
      'a negative rate',
      {
        market: 'mexico',
        category: 'marketing',
        usd_per_message: -0.1,
        effective_from: '2027-01-01',
      },
    ],
    [
      'six decimals',
      {
        market: 'mexico',
        category: 'marketing',
        usd_per_message: 0.074001,
        effective_from: '2027-01-01',
      },
    ],
    [
      'above numeric(8,5)',
      {
        market: 'mexico',
        category: 'marketing',
        usd_per_message: 1000,
        effective_from: '2027-01-01',
      },
    ],
    [
      'an impossible date',
      {
        market: 'mexico',
        category: 'marketing',
        usd_per_message: 0.1,
        effective_from: '2027-02-30',
      },
    ],
    [
      'a timestamp',
      {
        market: 'mexico',
        category: 'marketing',
        usd_per_message: 0.1,
        effective_from: '2027-01-01T00:00:00Z',
      },
    ],
  ])('refuses %s', (_label, body) => {
    expect(validateRateInput(body).ok).toBe(false);
  });
});

describe('classifyRate', () => {
  const rate = (
    over: Partial<{
      market: string;
      usd_per_message: number;
      effective_from: string;
    }>
  ) => ({
    market: 'rest_of_latam',
    category: 'marketing' as const,
    usd_per_message: 0.08,
    effective_from: '2027-01-01',
    ...over,
  });

  it('a later date is a new row', () => {
    expect(classifyRate(rate({}), EXISTING, TODAY)).toBe('new');
  });

  it('today is allowed: it supersedes from today on, not the past', () => {
    expect(classifyRate(rate({ effective_from: TODAY }), EXISTING, TODAY)).toBe(
      'new'
    );
  });

  it('the same key with the same price is `exists`, with another price `conflict`', () => {
    expect(
      classifyRate(
        rate({ usd_per_message: 0.074, effective_from: '2026-10-01' }),
        EXISTING,
        TODAY
      )
    ).toBe('exists');
    expect(
      classifyRate(rate({ effective_from: '2026-10-01' }), EXISTING, TODAY)
    ).toBe('conflict');
  });

  it('a past date over a rate already in force is retroactive', () => {
    expect(
      classifyRate(rate({ effective_from: '2026-11-01' }), EXISTING, TODAY)
    ).toBe('retroactive');
  });

  it('a past date for a market that had no rate yet is allowed', () => {
    expect(
      classifyRate(
        rate({ market: 'mexico', effective_from: '2026-10-01' }),
        EXISTING,
        TODAY
      )
    ).toBe('new');
  });
});

describe('previewRateImport', () => {
  it('parses the header, comments and blank lines, and classifies each line', () => {
    const csv = [
      'market,category,usd_per_message,effective_from',
      '# Meta, 2026-10-01',
      'rest_of_latam,marketing,0.0740,2026-10-01',
      '',
      'mexico,marketing,0.0436,2026-10-01',
      'mexico,utility,0.0085,2026-10-01',
    ].join('\n');
    const result = previewRateImport(csv, EXISTING, TODAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => [r.line, r.status])).toEqual([
      [3, 'exists'],
      [5, 'new'],
      [6, 'new'],
    ]);
    expect(result.value.importable).toBe(true);
    expect(result.value.toInsert).toHaveLength(2);
  });

  it('reads a spreadsheet export with ; and decimal comma', () => {
    const result = previewRateImport(
      'mexico;marketing;0,0436;2026-10-01\r\n',
      EXISTING,
      TODAY
    );
    expect(result.ok && result.value.toInsert[0].usd_per_message).toBe(0.0436);
  });

  it('blocks the import on an invalid, conflicting, retroactive or repeated line', () => {
    const csv = [
      'mexico,marketing,abc,2026-10-01',
      'rest_of_latam,marketing,0.09,2026-10-01',
      'rest_of_latam,service,0.02,2026-11-01',
      'chile,marketing,0.08,2027-01-01',
      'chile,marketing,0.08,2027-01-01',
      'too,few',
    ].join('\n');
    const result = previewRateImport(csv, EXISTING, TODAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.status)).toEqual([
      'invalid',
      'conflict',
      'retroactive',
      'new',
      'duplicate',
      'invalid',
    ]);
    expect(result.value.importable).toBe(false);
    expect(result.value.rows[0].error).toMatch(/usd_per_message/);
  });

  it('refuses an empty text and a text above the row cap', () => {
    expect(previewRateImport('\n\n', EXISTING, TODAY).ok).toBe(false);
    const huge = Array.from(
      { length: IMPORT_MAX_ROWS + 1 },
      (_, i) => `m${i},marketing,0.01,2027-01-01`
    ).join('\n');
    expect(previewRateImport(huge, EXISTING, TODAY)).toEqual({
      ok: false,
      error: `at most ${IMPORT_MAX_ROWS} rates per import`,
    });
  });
});

describe('validateMarketEntries', () => {
  it('normalises codes and markets and keeps null as a removal', () => {
    expect(
      validateMarketEntries({
        entries: [
          { country_code: 'do', market: 'Rest_Of_Latam' },
          { country_code: 'PR', market: null },
        ],
      })
    ).toEqual({
      ok: true,
      value: [
        { country_code: 'DO', market: 'rest_of_latam' },
        { country_code: 'PR', market: null },
      ],
    });
  });

  it.each([
    ['no entries key', {}],
    ['an empty list', { entries: [] }],
    [
      'a three-letter code',
      { entries: [{ country_code: 'DOM', market: 'x_y' }] },
    ],
    [
      'a bad market',
      { entries: [{ country_code: 'DO', market: 'Resto LatAm' }] },
    ],
    ['a missing market', { entries: [{ country_code: 'DO' }] }],
    [
      'a repeated country',
      {
        entries: [
          { country_code: 'DO', market: 'rest_of_latam' },
          { country_code: 'do', market: 'mexico' },
        ],
      },
    ],
  ])('refuses %s', (_label, body) => {
    expect(validateMarketEntries(body).ok).toBe(false);
  });
});
