import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import { EmbeddedSignupButton } from './embedded-signup-button';
import en from '../../../messages/en.json';

/**
 * Fase 4 §1, criterion 5 — the UI half of "self-hosted keeps working".
 *
 * The server answers `{ enabled: false }` when this deployment has no
 * Embedded Signup configuration, and the button has to vanish
 * completely: a "Connect WhatsApp" that opens a dialog for an app the
 * operator does not own is worse than no button at all.
 *
 * No jsdom / testing-library in this repo (and no new dependencies), so
 * the component is rendered to static markup — enough to pin presence
 * and absence, which is all this asserts.
 */
function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('EmbeddedSignupButton', () => {
  it('renders nothing in self-hosted mode', () => {
    const html = render(
      <EmbeddedSignupButton
        settings={{ enabled: false }}
        onConnected={() => {}}
      />
    );
    expect(html).toBe('');
  });

  it('renders nothing when the server says enabled but sends no config id', () => {
    // Defensive: a truncated response must not open a dialog against an
    // undefined Embedded Signup configuration.
    const html = render(
      <EmbeddedSignupButton
        settings={{ enabled: true, app_id: 'app-123' }}
        onConnected={() => {}}
      />
    );
    expect(html).toBe('');
  });

  it('renders the connect button in platform mode', () => {
    const html = render(
      <EmbeddedSignupButton
        settings={{
          enabled: true,
          app_id: 'app-123',
          config_id: 'cfgid-456',
          graph_version: 'v21.0',
        }}
        onConnected={() => {}}
      />
    );
    expect(html).toContain('Connect WhatsApp');
    // Disabled until the SDK has loaded: clicking before `FB` exists
    // would do nothing and look broken.
    expect(html).toContain('disabled');
  });
});
