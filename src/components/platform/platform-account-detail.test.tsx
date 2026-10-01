import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import { PlatformAccountDetail, type Detail } from './platform-account-detail';

// p11.1 R21 — the operator's file shows, per number, the WABA payment
// method in Meta and «Comprobar de nuevo». Since s10.6 the line lives in
// `AccountNumbersCard`; the file keeps the state and the POST and passes
// them down. Detailed markup tests: platform-numbers.test.tsx.

type Catalogue = typeof es;

function render(detail: Detail, messages: Catalogue = es, locale = 'es') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      <PlatformAccountDetail
        accountId={detail.accountId}
        initial={{ detail }}
      />
    </NextIntlClientProvider>
  );
}

const NUMBER = {
  id: 'cfg-1',
  phoneNumberId: 'pn-1',
  displayPhoneNumber: '+1 555 0100',
  verifiedName: 'Acme',
  label: null,
  wabaId: 'waba-1',
  status: 'connected',
  isDefault: true,
  registeredAt: null,
  lastRegistrationError: null,
};

const DETAIL: Detail = {
  accountId: 'aaaaaaaa-0000-4000-8000-000000000001',
  name: 'Acme',
  createdAt: '2026-01-01T00:00:00.000Z',
  planId: 'pro',
  planName: 'Pro',
  subscriptionStatus: 'active',
  provider: 'paypal',
  readOnly: false,
  manualHold: false,
  manualHoldAt: null,
  manualHoldReason: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  usage: [],
  limits: {},
  members: [],
  numbers: [],
  lastActivityAt: null,
  billingHistory: [],
  audit: [],
};

function paymentLine(html: string): string {
  const m = html.match(
    /<span[^>]*data-payment-status="[^"]*"[\s\S]*?<\/button><\/span>/
  );
  if (!m) throw new Error('no payment line');
  return m[0];
}

describe('PlatformAccountDetail — payment method per number (p11.1)', () => {
  // The markup of the line itself (badge per state, date, Meta's error,
  // disabled while checking) is tested on the card it lives in since
  // s10.6: platform-numbers.test.tsx. Here, only that the file wires it.

  it('the numbers card shows the payment line with an enabled re-check button', () => {
    const html = render({
      ...DETAIL,
      metaBilling: 'managed',
      numbers: [
        {
          ...NUMBER,
          metaPaymentStatus: 'missing',
          metaPaymentCheckedAt: '2026-10-01T10:00:00.000Z',
          metaPaymentError: null,
        },
      ],
    });
    const card = html.slice(html.indexOf('data-testid="account-numbers"'));
    const line = paymentLine(card);
    expect(line).toContain('data-payment-status="missing"');
    expect(line).toContain(es.Platform.paymentMissing);
    expect(line).toContain('Comprobado el');
    expect(line).toContain(es.Platform.paymentRecheck);
    expect(line).not.toContain('disabled=""');
    // s10.6 next to it: the WABA id and the Cabbity portfolio tag.
    expect(card).toContain('waba-1');
    expect(card).toContain(es.Platform.numbers.inCabbityPortfolio);
  });

  it('a number without WABA has no payment line', () => {
    const html = render({
      ...DETAIL,
      numbers: [{ ...NUMBER, wabaId: null }],
    });
    expect(html).not.toContain('data-payment-status');
  });

  it('English catalogue', () => {
    const html = render(
      {
        ...DETAIL,
        numbers: [{ ...NUMBER, metaPaymentStatus: 'missing' }],
      },
      en as Catalogue,
      'en'
    );
    expect(paymentLine(html)).toContain(en.Platform.paymentMissing);
    expect(paymentLine(html)).toContain(en.Platform.paymentRecheck);
  });
});
