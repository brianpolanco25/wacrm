import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import type { AccountIntegrationView } from '@/lib/integrations/types';
import {
  IntegrationsSettings,
  type IntegrationsPayload,
} from './integrations-settings';
import { SETTINGS_SECTIONS, SECTION_META } from './settings-sections';

// Ajustes → Integraciones (n13.1, R19, R34). Marcado estático por estado
// y por rol; la lógica de acciones está en integration-card-state.test.ts.

const CATALOGUES = { en, es } as const;

function view(over: Partial<AccountIntegrationView>): AccountIntegrationView {
  return {
    id: '9a000000-0000-4000-8000-000000000001',
    slug: 'health',
    name: 'Cabbity Health',
    description: 'Citas y doctores',
    logoUrl: null,
    authScheme: 'bearer',
    authHeaderName: null,
    credentialHelp: null,
    retired: false,
    operations: [
      {
        key: 'list_doctors',
        name: 'Listar doctores',
        description: 'Lista',
        method: 'GET',
      },
    ],
    enabled: false,
    credentialLast4: null,
    enabledAt: null,
    lastTestedAt: null,
    lastTestStatus: null,
    ...over,
  };
}

const ACTIVE = view({
  enabled: true,
  credentialLast4: '4242',
  enabledAt: '2026-11-02T10:00:00.000Z',
  lastTestedAt: '2026-11-02T10:00:05.000Z',
  lastTestStatus: 'ok',
});
const INACTIVE = view({
  id: '9a000000-0000-4000-8000-000000000002',
  slug: 'agenda',
  name: 'Agenda',
});
const RETIRED = view({
  id: '9a000000-0000-4000-8000-000000000003',
  slug: 'old-app',
  name: 'Old',
  retired: true,
  enabled: true,
  credentialLast4: null,
});

function render(
  payload: Partial<IntegrationsPayload> = {},
  locale: keyof typeof CATALOGUES = 'es'
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale]}
    >
      <IntegrationsSettings
        initial={{
          integrations: [ACTIVE, INACTIVE, RETIRED],
          planAllows: true,
          canManage: true,
          ...payload,
        }}
      />
    </NextIntlClientProvider>
  );
}

/** Acciones (`data-action`) dentro de la tarjeta de `slug`. */
function actionsOf(html: string, slug: string): string[] {
  const start = html.indexOf(`data-integration-card="${slug}"`);
  const next = html.indexOf('data-integration-card=', start + 1);
  const card = html.slice(start, next === -1 ? undefined : next);
  return [...card.matchAll(/data-action="([a-z]+)"/g)].map((m) => m[1]);
}

function statusOf(html: string, slug: string): string | undefined {
  return new RegExp(
    `data-integration-card="${slug}" data-status="([a-zA-Z]+)"`
  ).exec(html)?.[1];
}

describe('IntegrationsSettings — admin', () => {
  it('one card per integration with its state', () => {
    const html = render();
    expect(statusOf(html, 'health')).toBe('active');
    expect(statusOf(html, 'agenda')).toBe('inactive');
    expect(statusOf(html, 'old-app')).toBe('retired');
    expect(html).toContain(es.Settings.integrations.status.active);
    expect(html).toContain(es.Settings.integrations.status.inactive);
    expect(html).toContain(es.Settings.integrations.status.retired);
  });

  it('actions per state', () => {
    const html = render();
    expect(actionsOf(html, 'health')).toEqual(['test', 'change', 'deactivate']);
    expect(actionsOf(html, 'agenda')).toEqual(['activate']);
    expect(actionsOf(html, 'old-app')).toEqual(['deactivate']);
  });

  it('shows the saved credential only as ••••<last4>', () => {
    const html = render();
    expect(html).toContain('••••4242');
    expect(html).toContain('data-last-test="ok"');
    // RETIRED has no last4 (short credential): a bare mask.
    expect(html).toContain(es.Settings.integrations.credentialSavedHidden);
  });

  it('shows the initial when there is no logo, and the operations', () => {
    const html = render();
    expect(html).toMatch(/aria-hidden="true"[^>]*>C<\/span>/);
    expect(html).toContain('Listar doctores');
  });
});

describe('IntegrationsSettings — plan and role', () => {
  it('without the plan: «Requiere plan», an upgrade link, no activation', () => {
    const html = render({ planAllows: false });
    expect(html).toContain('data-plan-required');
    expect(html).toContain('href="/billing"');
    expect(statusOf(html, 'agenda')).toBe('planRequired');
    expect(actionsOf(html, 'agenda')).toEqual([]);
    expect(actionsOf(html, 'health')).toEqual(['deactivate']);
  });

  it('agent / viewer (canManage false): read only, no buttons', () => {
    const html = render({ canManage: false });
    expect(html).toContain('data-read-only');
    expect(html).not.toContain('data-action=');
    // The state is still visible.
    expect(html).toContain('••••4242');
  });

  it('n13.6: a support session manages, with a notice that it is recorded', () => {
    for (const locale of ['es', 'en'] as const) {
      const html = render({ supportSession: true }, locale);
      expect(html).toContain('data-support-notice');
      expect(html).toContain(
        CATALOGUES[locale].Settings.integrations.supportNotice
      );
      expect(html).not.toContain('data-read-only');
      expect(actionsOf(html, 'health')).toEqual([
        'test',
        'change',
        'deactivate',
      ]);
      expect(actionsOf(html, 'agenda')).toEqual(['activate']);
    }
  });

  it('no support notice for the customer’s own admin', () => {
    const html = render({ supportSession: false });
    expect(html).not.toContain('data-support-notice');
  });

  it('says so when the catalogue is empty', () => {
    expect(render({ integrations: [] })).toContain(
      es.Settings.integrations.empty
    );
  });
});

function leafKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) =>
    leafKeys(v, prefix ? `${prefix}.${k}` : k)
  );
}
const get = (o: unknown, key: string) =>
  key
    .split('.')
    .reduce((acc: unknown, k) => (acc as Record<string, unknown>)[k], o);
const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n (R34, CP6)', () => {
  it.each(['en', 'es'] as const)('is translated in %s', (loc) => {
    const html = render({}, loc);
    expect(html).toContain(CATALOGUES[loc].Settings.integrations.title);
    expect(html).toContain(CATALOGUES[loc].Settings.integrations.test);
    expect(html).not.toContain('Settings.integrations.');
  });

  it('es and en have the same keys and placeholders', () => {
    const pairs = [
      [es.Settings.integrations, en.Settings.integrations],
      [
        { x: es.Settings.sections.integrations },
        { x: en.Settings.sections.integrations },
      ],
    ] as const;
    for (const [a, b] of pairs) {
      expect(leafKeys(a).sort()).toEqual(leafKeys(b).sort());
      for (const key of leafKeys(a)) {
        expect(placeholders(String(get(a, key)))).toEqual(
          placeholders(String(get(b, key)))
        );
      }
    }
  });

  it('the section is in the rail for every member (not adminOnly)', () => {
    expect(SETTINGS_SECTIONS).toContain('integrations');
    expect(SECTION_META.integrations.adminOnly).toBeUndefined();
    expect(SECTION_META.integrations.group).toBe('workspace');
  });
});
