import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import { META_CATEGORIES } from '@/lib/billing/meta-rates';
import { PlatformRates, type RatesData } from './platform-rates';

// /platform/rates (s10.2). No jsdom in the repo: the first paint is
// rendered to static markup with pre-loaded data. What the page DOES is
// tested in the route tests and in `meta-rate-input.test.ts`.

const CATALOGUES = { en, es } as const;

const DATA: RatesData = {
  today: '2026-11-15',
  rates: [
    {
      market: 'rest_of_latam',
      category: 'marketing',
      usdPerMessage: 0.08,
      effectiveFrom: '2027-01-01',
      inForce: false,
      scheduled: true,
    },
    {
      market: 'rest_of_latam',
      category: 'marketing',
      usdPerMessage: 0.074,
      effectiveFrom: '2026-10-01',
      inForce: true,
      scheduled: false,
    },
    {
      market: 'rest_of_latam',
      category: 'service',
      usdPerMessage: 0.0113,
      effectiveFrom: '2026-10-01',
      inForce: true,
      scheduled: false,
    },
    {
      market: 'rest_of_latam',
      category: 'utility',
      usdPerMessage: 0.0113,
      effectiveFrom: '2026-08-01',
      inForce: false,
      scheduled: false,
    },
  ],
  markets: [
    { countryCode: 'DO', market: 'rest_of_latam' },
    { countryCode: 'MX', market: 'mexico' },
  ],
};

function render(locale: keyof typeof CATALOGUES, data: RatesData = DATA) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale]}
    >
      <PlatformRates initial={data} />
    </NextIntlClientProvider>
  );
}

describe('PlatformRates', () => {
  it('lists every rate with its effective date and state', () => {
    const html = render('es');
    expect(html).toContain('data-rate="rest_of_latam|marketing|2026-10-01"');
    expect(html).toContain('0.07400 USD');
    expect(html).toContain('0.01130 USD');
    expect(html.match(/data-rate-state="inForce"/g)).toHaveLength(2);
    expect(html).toContain('data-rate-state="scheduled"');
    expect(html).toContain('data-rate-state="past"');
    expect(html).toContain(es.Platform.rates.state.inForce);
  });

  it('offers «Nueva tarifa» and no way to edit or delete a rate', () => {
    const html = render('es');
    expect(html).toContain(es.Platform.rates.newRate);
    expect(html).toContain(es.Platform.rates.neverEdit);
    expect(html).not.toMatch(/Editar|Eliminar|Borrar/);
  });

  it('warns about markets without a rate in force (mexico, rest_of_world)', () => {
    expect(render('es')).toContain(
      'data-unpriced-markets="mexico,rest_of_world"'
    );
  });

  it('has the CSV importer with preview before saving', () => {
    const html = render('es');
    expect(html).toContain('data-section="import"');
    expect(html).toContain('<textarea');
    expect(html).toContain(es.Platform.rates.import.preview);
    // Nothing previewed yet: the import button is disabled.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-import-action/);
  });

  it('has the editable country → market table, with country names', () => {
    const html = render('es');
    expect(html).toContain('data-country="DO"');
    expect(html).toContain('data-country="MX"');
    expect(html).toContain('República Dominicana');
    expect(html).toContain('value="rest_of_latam"');
    expect(html).toContain(es.Platform.rates.markets.save);
  });

  it.each(['en', 'es'] as const)('is translated in %s (CP6)', (loc) => {
    const html = render(loc);
    expect(html).toContain(CATALOGUES[loc].Platform.rates.title);
    expect(html).not.toContain('Platform.rates.');
  });
});

describe('Platform.rates catalogue (CP6)', () => {
  function resolve(node: unknown, dotted: string): unknown {
    return dotted
      .split('.')
      .reduce<unknown>(
        (n, part) =>
          n && typeof n === 'object'
            ? (n as Record<string, unknown>)[part]
            : undefined,
        node
      );
  }

  it.each(['en', 'es'] as const)(
    'every static key the page asks for exists in %s',
    (loc) => {
      const source = readFileSync(
        path.join(process.cwd(), 'src/components/platform/platform-rates.tsx'),
        'utf8'
      );
      const keys = [
        ...new Set(
          [...source.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)].map((m) => m[1])
        ),
      ];
      expect(keys.length).toBeGreaterThan(30);
      for (const key of keys) {
        expect(
          resolve(CATALOGUES[loc].Platform.rates, key),
          `messages/${loc}.json is missing Platform.rates.${key}`
        ).toBeTypeOf('string');
      }
    }
  );

  it.each(['en', 'es'] as const)(
    'every category, state and import status has a label in %s',
    (loc) => {
      const rates = CATALOGUES[loc].Platform.rates as unknown as Record<
        string,
        Record<string, unknown>
      >;
      for (const c of META_CATEGORIES)
        expect(rates.categories[c]).toBeTypeOf('string');
      for (const s of ['inForce', 'scheduled', 'past'])
        expect(rates.state[s]).toBeTypeOf('string');
      for (const r of ['exists', 'conflict', 'retroactive'])
        expect(rates.refused[r]).toBeTypeOf('string');
      const status = (rates.import as Record<string, Record<string, unknown>>)
        .status;
      for (const s of [
        'new',
        'exists',
        'conflict',
        'retroactive',
        'invalid',
        'duplicate',
      ])
        expect(status[s]).toBeTypeOf('string');
    }
  );

  it('the nav entry is «Tarifas de Meta» / «Meta rates»', () => {
    expect(es.Platform.shell.nav.rates).toBe('Tarifas de Meta');
    expect(en.Platform.shell.nav.rates).toBe('Meta rates');
  });
});
