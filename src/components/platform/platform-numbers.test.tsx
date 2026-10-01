import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import {
  AccountNumbersCard,
  copyId,
  type WhatsAppNumber,
} from './platform-numbers';
import { PlatformAccountDetail, type Detail } from './platform-account-detail';

// s10.6: the numbers section of the operator's file. Static markup, like
// the rest of the panel tests: ids and their copy buttons, connection
// mode, and the «Cabbity CRM portfolio» tag only on managed accounts.

type Catalogue = typeof es;

function render(node: React.ReactNode, locale: 'es' | 'en' = 'es'): string {
  const messages = (locale === 'es' ? es : en) as Catalogue;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

const EMBEDDED: WhatsAppNumber = {
  id: 'cfg-1',
  phoneNumberId: '100234567890123',
  displayPhoneNumber: '+1 555 0100',
  verifiedName: 'Acme',
  label: 'Ventas',
  wabaId: '200987654321098',
  provisionedVia: 'embedded_signup',
  status: 'connected',
  isDefault: true,
  registeredAt: '2026-09-01T00:00:00.000Z',
  lastRegistrationError: null,
};

const MANUAL: WhatsAppNumber = {
  ...EMBEDDED,
  id: 'cfg-2',
  phoneNumberId: '100234567890999',
  displayPhoneNumber: '+1 555 0200',
  label: null,
  wabaId: null,
  provisionedVia: 'manual',
  isDefault: false,
};

const N = es.Platform.numbers;

describe('AccountNumbersCard', () => {
  it('shows the WABA id and the phone_number_id of every number, each with a copy button', () => {
    const html = render(
      <AccountNumbersCard numbers={[EMBEDDED, MANUAL]} metaBilling="direct" />
    );
    expect(html).toContain('200987654321098');
    expect(html).toContain('100234567890123');
    expect(html).toContain('100234567890999');
    expect(html).toContain(`aria-label="Copiar ${N.wabaId}"`);
    expect(html).toContain(`aria-label="Copiar ${N.phoneNumberId}"`);
    // Two ids on the first number, one on the second (no WABA saved).
    expect(html.split('aria-label="Copiar ').length - 1).toBe(3);
    expect(html).toContain(N.missing);
  });

  it('shows the connection mode: Embedded Signup or manual', () => {
    const html = render(
      <AccountNumbersCard numbers={[EMBEDDED, MANUAL]} metaBilling="direct" />
    );
    expect(html).toContain('data-mode="embedded_signup"');
    expect(html).toContain('data-mode="manual"');
    expect(html).toContain(N.modeEmbedded);
    expect(html).toContain(N.modeManual);
  });

  it('a number from an older payload without the mode reads as manual', () => {
    const { provisionedVia: _omit, ...legacy } = MANUAL;
    void _omit;
    const html = render(<AccountNumbersCard numbers={[legacy]} />);
    expect(html).toContain(N.modeManual);
    expect(html).not.toContain(N.modeEmbedded);
  });

  it('tags every number «En el portafolio de Cabbity CRM» on a managed account only', () => {
    const managed = render(
      <AccountNumbersCard numbers={[EMBEDDED, MANUAL]} metaBilling="managed" />
    );
    expect(managed.split(N.inCabbityPortfolio).length - 1).toBe(2);
    expect(managed).toContain(N.managedHint);

    for (const metaBilling of ['direct', undefined] as const) {
      const html = render(
        <AccountNumbersCard numbers={[EMBEDDED]} metaBilling={metaBilling} />
      );
      expect(html).not.toContain(N.inCabbityPortfolio);
      expect(html).not.toContain(N.managedHint);
    }
  });

  it('carries no link to Meta (the Billing Hub URL is not on this branch)', () => {
    const html = render(
      <AccountNumbersCard numbers={[EMBEDDED]} metaBilling="managed" />
    );
    expect(html).not.toContain('href=');
  });

  it('says so when the account has no number', () => {
    const html = render(
      <AccountNumbersCard numbers={[]} metaBilling="managed" />
    );
    expect(html).toContain(es.Platform.whatsappNone);
  });

  it('renders in English', () => {
    const html = render(
      <AccountNumbersCard numbers={[EMBEDDED]} metaBilling="managed" />,
      'en'
    );
    expect(html).toContain(en.Platform.numbers.inCabbityPortfolio);
    expect(html).toContain(en.Platform.numbers.modeEmbedded);
    expect(html).toContain('aria-label="Copy WABA ID"');
  });
});

// p11.1 R21 — per number with a WABA: the payment method of that WABA in
// Meta, when it was last checked, Meta's error when it could not be
// checked, and «Comprobar de nuevo». Also on `managed` accounts: there the
// WABA is Cabbity's and the operator is who must see it. Moved here from
// platform-account-detail.test.tsx when s10.6 extracted the card.
function paymentLine(html: string): string {
  const m = html.match(
    /<span[^>]*data-payment-status="[^"]*"[\s\S]*?<\/button><\/span>/
  );
  if (!m) throw new Error('no payment line');
  return m[0];
}

describe('AccountNumbersCard — payment method per number (p11.1)', () => {
  const recheck = () => undefined;

  it('a missing number of a managed account: red badge, date and the re-check button', () => {
    // The card does not branch on meta_billing for this line: it shows
    // whatever the number is, managed or not.
    const html = render(
      <AccountNumbersCard
        numbers={[
          {
            ...EMBEDDED,
            metaPaymentStatus: 'missing',
            metaPaymentCheckedAt: '2026-10-01T10:00:00.000Z',
            metaPaymentError: null,
          },
        ]}
        metaBilling="managed"
        onRecheckPayment={recheck}
      />
    );
    const line = paymentLine(html);
    expect(line).toContain('data-payment-status="missing"');
    expect(line).toContain(es.Platform.paymentStatus);
    expect(line).toContain(es.Platform.paymentMissing);
    expect(line).toContain('Comprobado el');
    expect(line).toContain(es.Platform.paymentRecheck);
    expect(line).not.toContain('disabled=""');
    // s10.6 stays: ids and the portfolio tag sit next to the payment line.
    expect(html).toContain('200987654321098');
    expect(html).toContain(N.inCabbityPortfolio);
  });

  it("unknown shows Meta's error", () => {
    const html = render(
      <AccountNumbersCard
        numbers={[
          {
            ...EMBEDDED,
            metaPaymentStatus: 'unknown',
            metaPaymentCheckedAt: '2026-10-01T10:00:00.000Z',
            metaPaymentError: '(#200) Permissions error',
          },
        ]}
        metaBilling="direct"
        onRecheckPayment={recheck}
      />
    );
    const line = paymentLine(html);
    expect(line).toContain(es.Platform.paymentUnknown);
    expect(line).toContain('(#200) Permissions error');
  });

  it('ok hides the error; never checked reads as pending', () => {
    const ok = paymentLine(
      render(
        <AccountNumbersCard
          numbers={[
            {
              ...EMBEDDED,
              metaPaymentStatus: 'ok',
              metaPaymentCheckedAt: '2026-10-01T10:00:00.000Z',
              metaPaymentError: 'stale',
            },
          ]}
          onRecheckPayment={recheck}
        />
      )
    );
    expect(ok).toContain(es.Platform.paymentOk);
    expect(ok).not.toContain('stale');
    const pending = paymentLine(
      render(
        <AccountNumbersCard
          numbers={[{ ...EMBEDDED, metaPaymentStatus: null }]}
          onRecheckPayment={recheck}
        />
      )
    );
    expect(pending).toContain('data-payment-status="pending"');
    expect(pending).toContain(es.Platform.paymentPending);
    expect(pending).not.toContain('Comprobado el');
  });

  it('a number without WABA has no payment line', () => {
    const html = render(
      <AccountNumbersCard numbers={[MANUAL]} onRecheckPayment={recheck} />
    );
    expect(html).not.toContain('data-payment-status');
    expect(html).not.toContain(es.Platform.paymentRecheck);
  });

  it('every re-check button is disabled while one number is being checked', () => {
    const html = render(
      <AccountNumbersCard
        numbers={[
          { ...EMBEDDED, metaPaymentStatus: 'missing' },
          { ...EMBEDDED, id: 'cfg-3', metaPaymentStatus: 'ok' },
        ]}
        checkingNumber="cfg-1"
        onRecheckPayment={recheck}
      />
    );
    const buttons = html.match(/<button[^>]*>Comprobar de nuevo<\/button>/g);
    expect(buttons).toHaveLength(2);
    for (const b of buttons ?? []) expect(b).toContain('disabled=""');
  });

  it('English catalogue', () => {
    const line = paymentLine(
      render(
        <AccountNumbersCard
          numbers={[{ ...EMBEDDED, metaPaymentStatus: 'missing' }]}
          onRecheckPayment={recheck}
        />,
        'en'
      )
    );
    expect(line).toContain(en.Platform.paymentMissing);
    expect(line).toContain(en.Platform.paymentRecheck);
  });
});

describe('copyId', () => {
  beforeEach(() => {
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  const MESSAGES = { copied: 'ok', copyFailed: 'ko' };

  it('writes the id to the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await expect(copyId('waba-1', MESSAGES, { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('waba-1');
    expect(toastMock.success).toHaveBeenCalledWith('ok');
  });

  it('reports a refused or missing clipboard instead of throwing', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    await expect(copyId('waba-1', MESSAGES, { writeText })).resolves.toBe(
      false
    );
    await expect(copyId('waba-1', MESSAGES, undefined)).resolves.toBe(false);
    expect(toastMock.error).toHaveBeenCalledTimes(2);
  });
});

describe('the operator file uses the numbers section', () => {
  const DETAIL: Detail = {
    accountId: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00.000Z',
    planId: 'gestionado',
    planName: 'Gestionado',
    subscriptionStatus: 'active',
    provider: 'manual',
    readOnly: false,
    manualHold: false,
    manualHoldAt: null,
    manualHoldReason: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    usage: [],
    limits: {},
    members: [],
    numbers: [EMBEDDED, MANUAL],
    lastActivityAt: null,
    billingHistory: [],
    audit: [],
    metaBilling: 'managed',
    metaPricing: {},
    paymentMethod: 'manual',
  };

  it('shows ids, mode and the portfolio tag for a managed company', () => {
    const html = render(
      <PlatformAccountDetail
        accountId={DETAIL.accountId}
        initial={{ detail: DETAIL }}
      />
    );
    expect(html).toContain('data-testid="account-numbers"');
    expect(html).toContain('200987654321098');
    expect(html).toContain('100234567890999');
    expect(html).toContain(N.modeEmbedded);
    expect(html).toContain(N.modeManual);
    expect(html).toContain(N.inCabbityPortfolio);
  });

  it('a direct company: ids and mode, no portfolio tag', () => {
    const html = render(
      <PlatformAccountDetail
        accountId={DETAIL.accountId}
        initial={{ detail: { ...DETAIL, metaBilling: 'direct' } }}
      />
    );
    expect(html).toContain('200987654321098');
    expect(html).toContain(N.modeEmbedded);
    expect(html).not.toContain(N.inCabbityPortfolio);
  });
});

describe('Platform.numbers keys (CP6: es and en)', () => {
  it('has the same keys in es and en', () => {
    expect(Object.keys(es.Platform.numbers).sort()).toEqual(
      Object.keys(en.Platform.numbers).sort()
    );
  });
});
