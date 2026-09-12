import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import { PlatformAccounts } from './platform-accounts';

/**
 * The panel's shell (spec §2, CP6). There is no jsdom in this repo and no
 * new dependency may be added, so the components are rendered to static
 * markup — which pins what a snapshot of the first paint can pin: the
 * chrome is translated in BOTH catalogues, and no key is missing from
 * either.
 *
 * What the panel DOES is tested where it happens: the route tests, the
 * data-layer tests and the tenant-isolation suite.
 */

function render(locale: 'en' | 'ko'): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={locale === 'en' ? en : ko}
    >
      <PlatformAccounts />
    </NextIntlClientProvider>
  );
}

/** Every `t('…')` key the panel's components ask for. */
function keysUsedBy(file: string): string[] {
  const source = readFileSync(
    path.join(process.cwd(), 'src/components/platform', file),
    'utf8'
  );
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) {
    keys.add(match[1]);
  }
  return [...keys];
}

function resolve(messages: Record<string, unknown>, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      messages
    );
}

describe('the platform panel is translated (CP6)', () => {
  it.each(['platform-accounts.tsx', 'platform-account-detail.tsx'])(
    'every key %s asks for exists in en AND ko',
    (file) => {
      const keys = keysUsedBy(file);
      // A guard against the regex quietly matching nothing and the test
      // passing on an empty list.
      expect(keys.length).toBeGreaterThan(10);

      for (const key of keys) {
        expect(
          resolve(en.Platform as Record<string, unknown>, key),
          `messages/en.json is missing Platform.${key}`
        ).toBeTypeOf('string');
        expect(
          resolve(ko.Platform as Record<string, unknown>, key),
          `messages/ko.json is missing Platform.${key}`
        ).toBeTypeOf('string');
      }
    }
  );

  it('the manual-hold notice exists in both catalogues', () => {
    // The tenant-facing half of fase 4 §2: a company suspended by hand
    // has to be told so, and told that paying will not lift it.
    for (const catalogue of [en, ko]) {
      expect(catalogue.Billing.heldTitle).toBeTypeOf('string');
      expect(catalogue.Billing.heldBody).toBeTypeOf('string');
    }
    expect(en.Billing.heldBody).not.toBe(ko.Billing.heldBody);
  });

  it('the sidebar entry exists in both catalogues', () => {
    expect(en.Sidebar.platform).toBeTypeOf('string');
    expect(ko.Sidebar.platform).toBeTypeOf('string');
  });
});

describe('PlatformAccounts, first paint', () => {
  it('names itself and offers the search, in English', () => {
    const html = render('en');
    expect(html).toContain(en.Platform.title);
    expect(html).toContain(en.Platform.subtitle);
    expect(html).toContain(en.Platform.searchPlaceholder);
  });

  it('is translated, not English with a Korean shell (CP6)', () => {
    const html = render('ko');
    expect(html).toContain(ko.Platform.title);
    expect(html).not.toContain(en.Platform.title);
  });

  it('opens on the loading state, never on "no customers"', () => {
    // The distinction the whole panel rests on: an operator who reads an
    // empty list as "we have no customers" will act on it.
    const html = render('en');
    expect(html).toContain(en.Platform.loading);
    expect(html).not.toContain(en.Platform.empty);
  });
});
