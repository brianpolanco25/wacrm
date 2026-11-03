import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

// /platform/integrations (n13.1, R11, R34). Sin jsdom: primer pintado
// con el catálogo precargado. Lo que hace la página está en los tests de
// ruta y en `integration-form.test.ts`.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import {
  PlatformIntegrations,
  type PlatformIntegrationListItem,
} from './platform-integrations';

const CATALOGUES = { en, es } as const;

const ITEMS: PlatformIntegrationListItem[] = [
  {
    id: '9a000000-0000-4000-8000-000000000001',
    slug: 'health',
    name: 'Cabbity Health',
    description: null,
    logo_url: null,
    base_url: 'https://health.example.com/api/v1',
    auth_scheme: 'bearer',
    auth_header_name: null,
    credential_help: null,
    test_path: '/me',
    is_active: true,
    sort_order: 1,
    operationsActive: 2,
    accountsEnabled: 7,
  },
  {
    id: '9a000000-0000-4000-8000-000000000002',
    slug: 'draft-app',
    name: 'Borrador',
    description: null,
    logo_url: null,
    base_url: 'https://draft.example.com',
    auth_scheme: 'bearer',
    auth_header_name: null,
    credential_help: null,
    test_path: '/',
    is_active: false,
    sort_order: 2,
    operationsActive: 0,
    accountsEnabled: 0,
  },
];

function render(locale: keyof typeof CATALOGUES, items = ITEMS) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale]}
    >
      <PlatformIntegrations initial={items} />
    </NextIntlClientProvider>
  );
}

/** Todas las rutas de hojas de un objeto de mensajes. */
function leafKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) =>
    leafKeys(v, prefix ? `${prefix}.${k}` : k)
  );
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('PlatformIntegrations', () => {
  it('lists every integration with status, active operations and accounts', () => {
    const html = render('es');
    expect(html).toContain('data-integration="health"');
    expect(html).toContain('data-integration="draft-app"');
    expect(html).toContain(
      'href="/platform/integrations/9a000000-0000-4000-8000-000000000001"'
    );
    expect(html).toContain('data-status="active"');
    expect(html).toContain('data-status="draft"');
    expect(html).toMatch(/>2<\/td>/);
    expect(html).toMatch(/>7<\/td>/);
    expect(html).toContain(es.Platform.integrations.create);
    // R10: no delete anywhere.
    expect(html).not.toMatch(/Eliminar|Borrar/);
  });

  it('says so when the catalogue is empty', () => {
    expect(render('es', [])).toContain(es.Platform.integrations.empty);
  });

  it.each(['en', 'es'] as const)('is translated in %s (CP6)', (loc) => {
    const html = render(loc);
    const m = CATALOGUES[loc].Platform.integrations;
    expect(html).toContain(m.title);
    expect(html).toContain(m.columns.accounts);
    expect(html).not.toContain('Platform.integrations.');
  });

  it('es and en have the same keys and placeholders (R34)', () => {
    for (const [a, b] of [
      [es.Platform.integrations, en.Platform.integrations],
      [
        { x: es.Platform.shell.nav.integrations },
        { x: en.Platform.shell.nav.integrations },
      ],
      [
        { x: es.Platform.plans.features.integrations },
        { x: en.Platform.plans.features.integrations },
      ],
    ] as const) {
      expect(leafKeys(a).sort()).toEqual(leafKeys(b).sort());
      for (const key of leafKeys(a)) {
        const get = (o: unknown) =>
          key
            .split('.')
            .reduce(
              (acc: unknown, k) => (acc as Record<string, unknown>)[k],
              o
            );
        expect(placeholders(String(get(a)))).toEqual(
          placeholders(String(get(b)))
        );
      }
    }
  });
});
