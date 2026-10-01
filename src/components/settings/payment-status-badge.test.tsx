import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

import {
  PaymentStatusBadge,
  type PaymentStatusBadgeProps,
} from './payment-status-badge';

// p11.1 R20 / R11 (UI): the payment-method line on a number card in
// Settings → WhatsApp. Four states, the date of the last check, the
// «Comprobar de nuevo» button only for who can edit settings, and
// nothing at all for `managed` accounts.

type Catalogue = typeof es;

function render(
  props: Partial<PaymentStatusBadgeProps> = {},
  messages: Catalogue = es,
  locale: 'es' | 'en' = 'es'
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      <PaymentStatusBadge
        status="ok"
        checkedAt="2026-10-01T10:00:00.000Z"
        metaBilling="direct"
        canRecheck
        busy={false}
        onRecheck={() => {}}
        {...props}
      />
    </NextIntlClientProvider>
  );
}

const w = es.Settings.whatsapp;

function recheckButton(html: string): string {
  const m = html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/);
  if (!m) throw new Error('no button');
  return m[0];
}

describe('PaymentStatusBadge', () => {
  it.each([
    ['ok', w.paymentOk],
    ['missing', w.paymentMissing],
    ['unknown', w.paymentUnknown],
    [null, w.paymentPending],
  ] as const)('%s → «%s»', (status, label) => {
    const html = render({ status });
    expect(html).toContain(label);
  });

  it('missing is red', () => {
    expect(render({ status: 'missing' })).toContain('text-red-400');
    expect(render({ status: 'ok' })).not.toContain('text-red-400');
  });

  it('shows when it was last checked, and nothing when never', () => {
    const html = render();
    expect(html).toContain('Comprobado el');
    expect(render({ checkedAt: null })).not.toContain('Comprobado el');
  });

  it('the re-check button is enabled for who can edit settings', () => {
    const button = recheckButton(render());
    expect(button).toContain(w.paymentRecheck);
    expect(button).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it('…and disabled without permission or while busy', () => {
    expect(recheckButton(render({ canRecheck: false }))).toMatch(
      /\sdisabled(=|\s|>)/
    );
    expect(recheckButton(render({ busy: true }))).toMatch(/\sdisabled(=|\s|>)/);
  });

  it('managed accounts see nothing (R20)', () => {
    expect(render({ metaBilling: 'managed', status: 'missing' })).toBe('');
  });

  it('nothing until it is known who pays Meta', () => {
    expect(render({ metaBilling: undefined, status: 'missing' })).toBe('');
  });

  it('English catalogue', () => {
    const html = render({ status: 'unknown' }, en as Catalogue, 'en');
    expect(html).toContain(en.Settings.whatsapp.paymentUnknown);
    expect(html).toContain(en.Settings.whatsapp.paymentRecheck);
  });
});
