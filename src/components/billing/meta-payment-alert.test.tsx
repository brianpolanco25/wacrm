import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

// p11.1 — the banner for a WABA without a payment method in Meta.
//   R15 missing: red, persistent, number count, Billing Hub in a new tab
//   R16 null: nothing
//   R17 unknown: the soft (non-destructive) notice
//   R24 every new key exists in es AND en with the same ICU placeholders

const h = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null,
}));
vi.mock('@/hooks/use-billing-status', () => ({
  useBillingStatus: () => h.status,
}));

import { MetaPaymentAlert } from './meta-payment-alert';
import { META_BILLING_HUB_URL } from '@/lib/whatsapp/payment-method';

type Catalogue = typeof es;

function render(messages: Catalogue = es, locale: 'es' | 'en' = 'es') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      <MetaPaymentAlert />
    </NextIntlClientProvider>
  );
}

const BASE = {
  planId: 'inicio',
  status: 'active',
  readOnly: false,
  graceUntil: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  readAt: 0,
  metaBilling: 'direct',
};

describe('MetaPaymentAlert', () => {
  it('missing: red banner with the count and the Billing Hub link in a new tab (R15)', () => {
    h.status = {
      ...BASE,
      metaPayment: { banner: 'missing', missingNumbers: 2 },
    };
    const html = render();
    expect(html).toContain(es.Billing.metaPayment.missingTitle);
    expect(html).toContain('2 números');
    expect(html).toContain('1 de octubre de 2026');
    expect(html).toContain(`href="${META_BILLING_HUB_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(es.Billing.metaPayment.openBillingHub);
    // Destructive variant, and no close button: it stays until fixed.
    expect(html).toMatch(/text-destructive|destructive/);
    expect(html).not.toMatch(/aria-label="(Cerrar|Close)"/);
  });

  it('missing with one number uses the singular', () => {
    h.status = {
      ...BASE,
      metaPayment: { banner: 'missing', missingNumbers: 1 },
    };
    expect(render()).toContain('Un número no tiene método de pago');
    expect(render(en as Catalogue, 'en')).toContain(
      'One number has no payment method'
    );
  });

  it('unknown: the soft notice, not the destructive one (R17)', () => {
    h.status = {
      ...BASE,
      metaPayment: { banner: 'unknown', missingNumbers: 0 },
    };
    const html = render();
    expect(html).toContain(es.Billing.metaPayment.unknownTitle);
    expect(html).toContain(es.Billing.metaPayment.unknownBody);
    expect(html).not.toContain(es.Billing.metaPayment.missingTitle);
    expect(html).toContain(`href="${META_BILLING_HUB_URL}"`);
    // The missing banner renders the destructive variant; this one does not.
    h.status = {
      ...BASE,
      metaPayment: { banner: 'missing', missingNumbers: 1 },
    };
    const red = render();
    const classOf = (s: string) =>
      s
        .match(
          /role="alert"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*role="alert"/
        )
        ?.slice(1)
        .join('');
    expect(classOf(html)).not.toBe(classOf(red));
  });

  it('banner null, no metaPayment or no status: nothing at all (R16)', () => {
    h.status = { ...BASE, metaPayment: { banner: null, missingNumbers: 0 } };
    expect(render()).toBe('');
    h.status = { ...BASE };
    expect(render()).toBe('');
    h.status = null;
    expect(render()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// R24 — catalogue parity of the new keys
// ---------------------------------------------------------------------------

function placeholders(message: string): string[] {
  // ICU argument names: `{count, plural, …}`, `{date}`. A `{text}` that
  // is the body of a plural branch (`one {tiene}`) is not an argument.
  const names = new Set<string>();
  for (const m of message.matchAll(/\{\s*([a-zA-Z_]\w*)\s*(,|\})/g)) {
    if (m[2] === '}') {
      const before = message.slice(0, m.index).trimEnd();
      if (/(?:^|\s)(?:zero|one|two|few|many|other|=\d+)$/.test(before)) {
        continue;
      }
    }
    names.add(m[1]);
  }
  return [...names].sort();
}

function pick(cat: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], cat);
}

const NEW_KEYS = [
  ...[
    'missingTitle',
    'missingBody',
    'unknownTitle',
    'unknownBody',
    'openBillingHub',
  ].map((k) => `Billing.metaPayment.${k}`),
  ...[
    'paymentOk',
    'paymentMissing',
    'paymentUnknown',
    'paymentPending',
    'paymentCheckedAt',
    'paymentRecheck',
    'paymentRecheckFailed',
  ].map((k) => `Settings.whatsapp.${k}`),
  ...[
    'paymentStatus',
    'paymentOk',
    'paymentMissing',
    'paymentUnknown',
    'paymentPending',
    'paymentCheckedAt',
    'paymentRecheck',
    'paymentRecheckFailed',
  ].map((k) => `Platform.${k}`),
];

describe('p11.1 keys exist in es and en with the same placeholders (R24)', () => {
  it.each(NEW_KEYS)('%s', (key) => {
    const a = pick(es as Record<string, unknown>, key);
    const b = pick(en as Record<string, unknown>, key);
    expect(a, `es.json is missing ${key}`).toBeTypeOf('string');
    expect(b, `en.json is missing ${key}`).toBeTypeOf('string');
    expect(placeholders(a as string)).toEqual(placeholders(b as string));
  });

  it('the placeholders are the ones the code passes', () => {
    expect(placeholders(es.Billing.metaPayment.missingBody)).toEqual(['count']);
    expect(placeholders(es.Settings.whatsapp.paymentCheckedAt)).toEqual([
      'date',
    ]);
    expect(placeholders(es.Platform.paymentCheckedAt)).toEqual(['date']);
  });

  it('no Korean catalogue came back (s9.9)', async () => {
    const fs = await import('node:fs');
    expect(fs.existsSync('messages/ko.json')).toBe(false);
  });
});
