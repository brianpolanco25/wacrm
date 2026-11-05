import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import {
  IntegrationAiControls,
  type IntegrationViewWithAi,
} from './integration-ai-controls';
import {
  IntegrationsSettings,
  type IntegrationsPayload,
} from './integrations-settings';

// n13.3 R34: «Usar en IA» en Ajustes → Integraciones. Marcado estático.

const CATALOGUES = { en, es } as const;

function view(
  over: Partial<IntegrationViewWithAi> = {}
): IntegrationViewWithAi {
  return {
    id: '9a000000-0000-4000-8000-000000000001',
    slug: 'health',
    name: 'Cabbity Health',
    description: null,
    logoUrl: null,
    authScheme: 'bearer',
    authHeaderName: null,
    credentialHelp: null,
    retired: false,
    operations: [],
    enabled: true,
    credentialLast4: '4242',
    enabledAt: '2026-11-02T10:00:00.000Z',
    lastTestedAt: null,
    lastTestStatus: null,
    aiEnabled: false,
    aiInstructions: null,
    aiTimezone: null,
    ...over,
  };
}

function render(
  node: React.ReactNode,
  locale: keyof typeof CATALOGUES = 'es'
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale]}
    >
      {node}
    </NextIntlClientProvider>
  );
}

const noop = () => {};
const controls = (
  v: IntegrationViewWithAi,
  disabled = false,
  locale: 'es' | 'en' = 'es'
) =>
  render(
    <IntegrationAiControls
      integration={v}
      disabled={disabled}
      onToggle={noop}
      onEdit={noop}
    />,
    locale
  );

/** The opening tag of the first element carrying `attr`. */
function tagWith(html: string, attr: string): string {
  const at = html.indexOf(attr);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

/** `disabled=""` / `aria-disabled="true"`, not a `disabled:` class. */
const isDisabled = (tag: string) =>
  /\sdisabled=""/.test(tag) || /aria-disabled="true"/.test(tag);

describe('IntegrationAiControls', () => {
  it.each(['es', 'en'] as const)(
    '[%s] off: switch unchecked, no instructions button',
    (locale) => {
      const s = CATALOGUES[locale].Settings.integrations;
      const html = controls(view(), false, locale);
      expect(html).toContain(s.aiToggle);
      expect(html).toContain(s.aiToggleHint);
      const sw = tagWith(html, 'role="switch"');
      expect(sw).toContain('aria-checked="false"');
      expect(html).not.toContain('data-action="ai-instructions"');
    }
  );

  it.each(['es', 'en'] as const)(
    '[%s] on: switch checked and the instructions button',
    (locale) => {
      const s = CATALOGUES[locale].Settings.integrations;
      const html = controls(
        view({ aiEnabled: true, aiTimezone: 'America/Santo_Domingo' }),
        false,
        locale
      );
      expect(tagWith(html, 'role="switch"')).toContain('aria-checked="true"');
      const button = tagWith(html, 'data-action="ai-instructions"');
      expect(isDisabled(button)).toBe(false);
      expect(html).toContain(s.aiInstructionsButton);
      expect(html).toContain('America/Santo_Domingo');
    }
  );

  it('read-only / no plan: everything disabled', () => {
    const html = controls(view({ aiEnabled: true }), true);
    expect(isDisabled(tagWith(html, 'role="switch"'))).toBe(true);
    expect(isDisabled(tagWith(html, 'data-action="ai-instructions"'))).toBe(
      true
    );
  });

  it('not rendered for an integration that is not activated', () => {
    expect(controls(view({ enabled: false }))).toBe('');
  });
});

describe('IntegrationsSettings renders the AI controls on activated cards', () => {
  const payload = (
    over: Partial<IntegrationsPayload> = {}
  ): IntegrationsPayload => ({
    integrations: [
      view({ aiEnabled: true }),
      view({
        id: '9a000000-0000-4000-8000-000000000002',
        slug: 'agenda',
        name: 'Agenda',
        enabled: false,
        credentialLast4: null,
      }),
    ],
    planAllows: true,
    canManage: true,
    ...over,
  });

  it('only the activated integration gets the controls, enabled for a manager', () => {
    const html = render(<IntegrationsSettings initial={payload()} />);
    expect(html).toContain('data-ai-controls="health"');
    expect(html).not.toContain('data-ai-controls="agenda"');
    expect(isDisabled(tagWith(html, 'data-action="ai-instructions"'))).toBe(
      false
    );
  });

  it.each([
    ['read-only', { canManage: false }],
    ['no plan', { planAllows: false }],
  ])('%s: disabled', (_label, over) => {
    const html = render(<IntegrationsSettings initial={payload(over)} />);
    expect(isDisabled(tagWith(html, 'data-action="ai-instructions"'))).toBe(
      true
    );
  });
});
