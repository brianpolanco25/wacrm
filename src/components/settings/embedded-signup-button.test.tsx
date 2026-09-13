import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import {
  EmbeddedSignupButton,
  buildFbLoginOptions,
  isMetaSignupOrigin,
} from './embedded-signup-button';
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

/**
 * Fase 4 §1 — the two halves of the dialog contract that were realigned
 * with Meta's live documentation (Embedded Signup v4). See
 * `progress/meta_embedded-signup-verificacion.md`.
 */
describe('buildFbLoginOptions', () => {
  it('passes only `setup` in extras, as Embedded Signup v4 documents', () => {
    const options = buildFbLoginOptions('cfgid-456');
    // `sessionInfoVersion` and `featureType` are from earlier versions
    // of the flow and no longer exist: sending them is at best noise.
    expect(options.extras).toEqual({ setup: {} });
    expect(Object.keys(options.extras as object)).toEqual(['setup']);
  });

  it('asks for a code, overriding the SDK default', () => {
    const options = buildFbLoginOptions('cfgid-456');
    expect(options.config_id).toBe('cfgid-456');
    expect(options.response_type).toBe('code');
    // Without this Meta returns a user access token and there is no
    // code for the server to exchange.
    expect(options.override_default_response_type).toBe(true);
  });
});

describe('isMetaSignupOrigin', () => {
  it('accepts the hosts Meta serves the dialog from', () => {
    expect(isMetaSignupOrigin('https://www.facebook.com')).toBe(true);
    expect(isMetaSignupOrigin('https://web.facebook.com')).toBe(true);
    // Not in the old two-origin list, and a real Meta host: this is the
    // case a closed list would have dropped in silence.
    expect(isMetaSignupOrigin('https://business.facebook.com')).toBe(true);
    expect(isMetaSignupOrigin('https://facebook.com')).toBe(true);
  });

  it('rejects a look-alike domain that merely ends in facebook.com', () => {
    // The trap in Meta's own `origin.endsWith('facebook.com')` snippet.
    expect(isMetaSignupOrigin('https://facebook.com.evil.example')).toBe(false);
    expect(isMetaSignupOrigin('https://notfacebook.com')).toBe(false);
  });

  it('rejects plain HTTP and anything that is not a URL', () => {
    expect(isMetaSignupOrigin('http://www.facebook.com')).toBe(false);
    // `postMessage` from a sandboxed frame reports the string "null".
    expect(isMetaSignupOrigin('null')).toBe(false);
    expect(isMetaSignupOrigin('')).toBe(false);
  });
});
