import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import {
  EmbeddedSignupButton,
  buildFbLoginOptions,
  buildSignupRequestBody,
  isMetaSignupOrigin,
  parseSignupSessionMessage,
  signupResultMessageKey,
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
  it('passes `setup` and the coexistence featureType in extras (R1)', () => {
    const options = buildFbLoginOptions('cfgid-456');
    // Meta's coexistence guide requires `featureType` in v4 for the
    // dialog to offer "connect your WhatsApp Business app"; a dialog
    // without coexistence ignores it.
    expect(options.extras).toEqual({
      setup: {},
      featureType: 'whatsapp_business_app_onboarding',
    });
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

/** #1650 R2 — what each session message from the dialog means. */
describe('parseSignupSessionMessage', () => {
  const msg = (event: string, data: Record<string, string> = {}) =>
    JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data });

  it('reads FINISH as an ordinary (non-coexistence) finish', () => {
    expect(
      parseSignupSessionMessage(
        msg('FINISH', { phone_number_id: 'pn-1', waba_id: 'waba-1' })
      )
    ).toEqual({
      kind: 'finish',
      phoneNumberId: 'pn-1',
      wabaId: 'waba-1',
      coexistence: false,
    });
  });

  it('reads FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING as coexistence', () => {
    expect(
      parseSignupSessionMessage(
        msg('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', {
          phone_number_id: 'pn-2',
          waba_id: 'waba-2',
        })
      )
    ).toEqual({
      kind: 'finish',
      phoneNumberId: 'pn-2',
      wabaId: 'waba-2',
      coexistence: true,
    });
  });

  it('accepts a coexistence finish that carries only waba_id', () => {
    // Meta's FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING sends no
    // phone_number_id: the server resolves it from the WABA.
    expect(
      parseSignupSessionMessage(
        msg('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', { waba_id: 'waba-3' })
      )
    ).toEqual({
      kind: 'finish',
      phoneNumberId: undefined,
      wabaId: 'waba-3',
      coexistence: true,
    });
  });

  it('reads CANCEL and ERROR as before', () => {
    expect(
      parseSignupSessionMessage(msg('CANCEL', { current_step: 'PHONE' }))
    ).toEqual({ kind: 'cancel', step: 'PHONE' });
    expect(parseSignupSessionMessage(msg('CANCEL'))).toEqual({
      kind: 'cancel',
      step: 'unknown',
    });
    expect(
      parseSignupSessionMessage(msg('ERROR', { error_message: 'boom' }))
    ).toEqual({ kind: 'error', message: 'boom' });
  });

  it('ignores non-JSON housekeeping and other message types', () => {
    expect(parseSignupSessionMessage('not json {')).toBeNull();
    expect(parseSignupSessionMessage(undefined)).toBeNull();
    expect(
      parseSignupSessionMessage(
        JSON.stringify({ type: 'SOMETHING_ELSE', event: 'FINISH' })
      )
    ).toBeNull();
    expect(parseSignupSessionMessage(msg('UNKNOWN_EVENT'))).toBeNull();
  });
});

/** #1650 R3 — the body the route receives. */
describe('buildSignupRequestBody', () => {
  it('sends the ids and a boolean coexistence flag', () => {
    expect(
      buildSignupRequestBody('code-1', {
        phoneNumberId: 'pn-1',
        wabaId: 'waba-1',
        coexistence: true,
      })
    ).toEqual({
      code: 'code-1',
      phone_number_id: 'pn-1',
      waba_id: 'waba-1',
      coexistence: true,
    });
    // Coexistence without phone_number_id: the field is omitted.
    expect(
      buildSignupRequestBody('code-3', {
        wabaId: 'waba-3',
        coexistence: true,
      })
    ).toEqual({ code: 'code-3', waba_id: 'waba-3', coexistence: true });
    expect(
      buildSignupRequestBody('code-2', {
        phoneNumberId: 'pn-2',
        wabaId: 'waba-2',
        coexistence: false,
      }).coexistence
    ).toBe(false);
  });
});

/** #1650 R4 — which toast a 200 deserves. */
describe('signupResultMessageKey', () => {
  it('coexistence without sync failures → signupCoexistenceSuccess', () => {
    expect(
      signupResultMessageKey({
        coexistence: true,
        registration_error: null,
        smb_sync: { state_sync: 'requested', history: 'already_done' },
      })
    ).toBe('signupCoexistenceSuccess');
  });

  it('coexistence with a failed sync → signupCoexistenceSyncFailed', () => {
    expect(
      signupResultMessageKey({
        coexistence: true,
        smb_sync: { state_sync: 'requested', history: 'failed' },
      })
    ).toBe('signupCoexistenceSyncFailed');
  });

  it('ordinary flow keeps the current logic', () => {
    expect(signupResultMessageKey({ registration_error: 'pin' })).toBe(
      'signupRegistrationFailed'
    );
    expect(
      signupResultMessageKey({ coexistence: false, registration_error: null })
    ).toBe('signupSuccess');
  });
});
