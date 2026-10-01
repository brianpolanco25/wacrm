import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import { PlatformAccountDetail, type Detail } from './platform-account-detail';

// p11.1 R21 — the operator's file shows, per number, the WABA payment
// method in Meta, when it was last checked, Meta's error when it could
// not be checked, and «Comprobar de nuevo». Also for `managed` accounts:
// there the WABA is Cabbity's and the operator is who must see it.

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
  it('a missing number of a managed account: red badge, date and the re-check button', () => {
    // The file does not branch on meta_billing at all: the line shows
    // whatever the number is, managed or not.
    const html = render({
      ...DETAIL,
      numbers: [
        {
          ...NUMBER,
          metaPaymentStatus: 'missing',
          metaPaymentCheckedAt: '2026-10-01T10:00:00.000Z',
          metaPaymentError: null,
        },
      ],
    });
    const line = paymentLine(html);
    expect(line).toContain('data-payment-status="missing"');
    expect(line).toContain(es.Platform.paymentStatus);
    expect(line).toContain(es.Platform.paymentMissing);
    expect(line).toContain('Comprobado el');
    expect(line).toContain(es.Platform.paymentRecheck);
  });

  it("unknown shows Meta's error", () => {
    const html = render({
      ...DETAIL,
      numbers: [
        {
          ...NUMBER,
          metaPaymentStatus: 'unknown',
          metaPaymentCheckedAt: '2026-10-01T10:00:00.000Z',
          metaPaymentError: '(#200) Permissions error',
        },
      ],
    });
    const line = paymentLine(html);
    expect(line).toContain(es.Platform.paymentUnknown);
    expect(line).toContain('(#200) Permissions error');
  });

  it('ok hides the error; never checked reads as pending', () => {
    const ok = paymentLine(
      render({
        ...DETAIL,
        numbers: [
          {
            ...NUMBER,
            metaPaymentStatus: 'ok',
            metaPaymentCheckedAt: '2026-10-01T10:00:00.000Z',
            metaPaymentError: 'stale',
          },
        ],
      })
    );
    expect(ok).toContain(es.Platform.paymentOk);
    expect(ok).not.toContain('stale');
    const pending = paymentLine(
      render({
        ...DETAIL,
        numbers: [{ ...NUMBER, metaPaymentStatus: null }],
      })
    );
    expect(pending).toContain(es.Platform.paymentPending);
    expect(pending).not.toContain('Comprobado el');
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
