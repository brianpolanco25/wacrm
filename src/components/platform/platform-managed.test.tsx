import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import { META_CATEGORIES } from '@/lib/billing/meta-rates';
import {
  formToPricing,
  pricingToForm,
  termsBody,
  termsFromPlan,
} from './managed-form';
import {
  CheckoutLinkNotice,
  ManagedPricingCard,
  ManagedTermsFields,
  saveManagedPricing,
} from './platform-managed';
import { PlanAssignment, type PlanOption } from './platform-provisioning';
import { PlatformAccountDetail, type Detail } from './platform-account-detail';

// s10.3 UI, rendered to static markup like the rest of the panel (no
// jsdom). What the buttons DO is tested on the routes; here, the first
// paint, the form ↔ `meta_pricing` mapping, and both catalogues.

type Catalogue = typeof es;
const CATALOGUES: Array<['es' | 'en', Catalogue]> = [
  ['es', es],
  ['en', en as Catalogue],
];

function render(
  node: React.ReactNode,
  locale: 'es' | 'en' = 'es',
  messages: Catalogue = es
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

const DEFAULT = {
  included_messages: 7000,
  fee_usd: 1036,
  overage: {
    service: { multiplier: 2.5 },
    utility: { multiplier: 2.5 },
    marketing: { multiplier: 2.5 },
    authentication: { multiplier: 2.5 },
    authentication_international: { multiplier: 2.5 },
  },
};

const PLANS: PlanOption[] = [
  { id: 'inicio', name: 'Inicio', isPublic: true, metaPricing: null },
  {
    id: 'gestionado',
    name: 'Gestionado',
    isPublic: false,
    metaPricing: DEFAULT,
  },
];

const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const noop = () => {};

function assignment(initialChoice = '') {
  return (
    <PlanAssignment
      accountId={ACCOUNT}
      accountName="Acme"
      planId="inicio"
      planName="Inicio"
      provider="paypal"
      subscriptionStatus="incomplete"
      plans={PLANS}
      onChanged={noop}
      initialChoice={initialChoice}
    />
  );
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('managed-form', () => {
  it('preloads the plan default and turns it back into the same policy', () => {
    const terms = termsFromPlan(DEFAULT);
    expect(terms.paymentMethod).toBe('manual');
    expect(terms.managed).toBe(true);
    expect(terms.pricing.included).toBe('7000');
    expect(terms.pricing.fee).toBe('1036');
    expect(terms.pricing.overage.marketing).toEqual({
      mode: 'multiplier',
      value: '2.5',
    });
    expect(formToPricing(terms.pricing)).toEqual({ ok: true, value: DEFAULT });
  });

  it('a fixed USD amount wins on screen and is the only thing saved', () => {
    const form = pricingToForm({
      ...DEFAULT,
      overage: {
        ...DEFAULT.overage,
        marketing: { multiplier: 2.5, usd_per_message: 0.2 },
      },
    });
    expect(form.overage.marketing).toEqual({ mode: 'usd', value: '0.2' });
    const back = formToPricing(form);
    expect(back.ok && back.value.overage.marketing).toEqual({
      usd_per_message: 0.2,
    });
  });

  it('accepts a decimal comma (2,5) like a Spanish keyboard types it', () => {
    const form = pricingToForm(DEFAULT);
    form.overage.utility.value = '3,1';
    const back = formToPricing(form);
    expect(back.ok && back.value.overage.utility).toEqual({ multiplier: 3.1 });
  });

  it.each([
    ['an empty fee', (f: ReturnType<typeof pricingToForm>) => (f.fee = '')],
    [
      'a negative included',
      (f: ReturnType<typeof pricingToForm>) => (f.included = '-1'),
    ],
    [
      'a multiplier of 0',
      (f: ReturnType<typeof pricingToForm>) =>
        (f.overage.marketing.value = '0'),
    ],
    [
      'letters',
      (f: ReturnType<typeof pricingToForm>) =>
        (f.overage.service.value = 'abc'),
    ],
  ])('refuses %s, with the validator of the routes', (_label, mutate) => {
    const form = pricingToForm(DEFAULT);
    mutate(form);
    expect(formToPricing(form).ok).toBe(false);
  });

  it('an empty or malformed policy gives empty fields, never a price', () => {
    const form = pricingToForm({});
    expect(form.included).toBe('');
    expect(formToPricing(form).ok).toBe(false);
    expect(pricingToForm({ fee_usd: 'x' }).fee).toBe('');
  });

  it('builds the body of the plan route: managed with the price, or direct without', () => {
    const terms = termsFromPlan(DEFAULT);
    expect(termsBody({ ...terms, paymentMethod: 'paypal' })).toEqual({
      ok: true,
      body: {
        paymentMethod: 'paypal',
        metaBilling: 'managed',
        metaPricing: DEFAULT,
      },
    });
    expect(termsBody({ ...terms, managed: false })).toEqual({
      ok: true,
      body: { paymentMethod: 'manual', metaBilling: 'direct' },
    });
  });
});

describe('«Asignar plan a mano» with the managed plan', () => {
  it('shows nothing extra for a plan without a price policy', () => {
    const html = render(assignment('inicio'));
    expect(html).not.toContain('data-managed-terms');
    expect(html).not.toContain(es.Platform.managed.paymentMethod);
  });

  it('shows method, «Meta lo paga Cabbity CRM» ticked and the price preloaded', () => {
    const html = render(assignment('gestionado'));
    expect(html).toContain('data-managed-terms');
    expect(html).toContain(es.Platform.managed.paymentMethod);
    expect(html).toContain(es.Platform.managed.methods.manual);
    expect(html).toContain(es.Platform.managed.methods.paypal);
    expect(html).toContain(es.Platform.managed.metaManaged);
    // Ticked by default for this plan.
    expect(html).toContain('aria-checked="true"');
    expect(html).toMatch(/id="managed-meta"[^>]*checked=""/);
    expect(html).toContain('value="7000"');
    expect(html).toContain('value="1036"');
    for (const category of META_CATEGORIES) {
      expect(html).toContain(`data-overage="${category}"`);
    }
    expect(html.match(/value="2.5"/g)).toHaveLength(META_CATEGORIES.length);
  });

  it.each(CATALOGUES)('is translated in %s (CP6)', (locale, messages) => {
    const html = render(assignment('gestionado'), locale, messages);
    expect(html).toContain(messages.Platform.managed.termsTitle);
    expect(html).toContain(messages.Platform.managed.overageTitle);
    expect(html).toContain(messages.Platform.managed.category.marketing);
  });
});

describe('ManagedTermsFields', () => {
  it('without «Meta lo paga Cabbity CRM», no price fields', () => {
    const html = render(
      <ManagedTermsFields
        value={{ ...termsFromPlan(DEFAULT), managed: false }}
        onChange={noop}
      />
    );
    expect(html).not.toContain('data-pricing-fields');
    expect(html).toContain(es.Platform.managed.metaDirectHelp);
  });

  it('with PayPal, says the account waits for PayPal', () => {
    const html = render(
      <ManagedTermsFields
        value={{ ...termsFromPlan(DEFAULT), paymentMethod: 'paypal' }}
        onChange={noop}
      />
    );
    expect(html).toContain(es.Platform.managed.paypalHelp);
  });
});

describe('the PayPal link on the file', () => {
  const DETAIL: Detail = {
    accountId: ACCOUNT,
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00.000Z',
    planId: 'gestionado',
    planName: 'Gestionado',
    subscriptionStatus: 'incomplete',
    provider: 'paypal',
    readOnly: true,
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
    metaBilling: 'managed',
    metaPricing: DEFAULT,
    paymentMethod: 'paypal',
  };
  const LINK =
    'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1';

  it('renders nothing without a link', () => {
    expect(render(<CheckoutLinkNotice url={null} />)).toBe('');
  });

  it('the file keeps the link across a reload, with the managed price block', () => {
    const html = render(
      <PlatformAccountDetail
        accountId={ACCOUNT}
        initial={{ detail: DETAIL, checkoutLink: LINK }}
      />
    );
    expect(html).toContain('data-checkout-link');
    expect(html).toContain(LINK.replace(/&/g, '&amp;'));
    expect(html).toContain(es.Platform.managed.checkoutHelp);
    expect(html).toContain('data-managed-pricing');
  });

  it('a direct company has no managed price block', () => {
    const html = render(
      <PlatformAccountDetail
        accountId={ACCOUNT}
        initial={{
          detail: { ...DETAIL, metaBilling: 'direct', metaPricing: {} },
        }}
      />
    );
    expect(html).not.toContain('data-managed-pricing');
  });
});

describe('«Precio de Meta gestionado»', () => {
  it('shows the stored price, the method and the rule about issued statements', () => {
    const html = render(
      <ManagedPricingCard
        accountId={ACCOUNT}
        metaPricing={{
          ...DEFAULT,
          overage: {
            ...DEFAULT.overage,
            marketing: { usd_per_message: 0.15 },
          },
        }}
        paymentMethod="manual"
        onChanged={noop}
      />
    );
    expect(html).toContain(es.Platform.managed.pricingTitle);
    expect(html).toContain(es.Platform.managed.pricingHelp);
    expect(html).toContain(es.Platform.managed.methodShort.manual);
    expect(html).toContain('value="0.15"');
    // Cannot save before a reason.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*?Guardar precio</);
  });

  it.each([
    [200, { changed: true }, { kind: 'saved', changed: true }],
    [200, { changed: false }, { kind: 'saved', changed: false }],
    [409, { code: 'not_managed' }, { kind: 'error', reason: 'notManaged' }],
    [409, { code: 'paypal_active' }, { kind: 'error', reason: 'paypalActive' }],
    [
      409,
      { code: 'needs_checkout' },
      { kind: 'error', reason: 'needsCheckout' },
    ],
    [
      400,
      { error: 'metaPricing: bad' },
      { kind: 'error', reason: 'invalid', detail: 'metaPricing: bad' },
    ],
    [500, {}, { kind: 'error', reason: 'failed' }],
  ])('HTTP %s %j → %j', async (status, body, expected) => {
    const outcome = await saveManagedPricing(
      ACCOUNT,
      { reason: 'x'.repeat(10), metaPricing: DEFAULT, paymentMethod: 'manual' },
      fakeFetch(status, body)
    );
    expect(outcome).toEqual(expected);
  });
});

/** Every `t('…')` key a component asks for (literal keys). */
function keysUsedBy(file: string, fn = 't'): string[] {
  const source = readFileSync(
    path.join(process.cwd(), 'src/components/platform', file),
    'utf8'
  );
  const keys = new Set<string>();
  const re = new RegExp(`\\b${fn}\\(\\s*'([A-Za-z0-9_.]+)'`, 'g');
  for (const match of source.matchAll(re)) keys.add(match[1]);
  return [...keys];
}

function resolve(messages: Record<string, unknown>, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      messages
    );
}

describe('every key exists in es AND en (CP6)', () => {
  it('Platform.managed', () => {
    const keys = [
      ...keysUsedBy('platform-managed.tsx'),
      // `tm` in «Asignar plan a mano».
      ...keysUsedBy('platform-provisioning.tsx', 'tm'),
      // Asked for by template.
      ...META_CATEGORIES.map((c) => `category.${c}`),
      'mode.multiplier',
      'mode.usd',
      'methods.manual',
      'methods.paypal',
      'methodShort.manual',
      'methodShort.paypal',
      'errors.notManaged',
      'errors.paypalActive',
      'errors.needsCheckout',
      'errors.failed',
    ];
    expect(keys.length).toBeGreaterThan(30);
    for (const [locale, catalogue] of CATALOGUES) {
      const ns = (catalogue.Platform as Record<string, unknown>).managed;
      for (const key of keys) {
        expect(
          resolve(ns as Record<string, unknown>, key),
          `messages/${locale}.json is missing Platform.managed.${key}`
        ).toBeTypeOf('string');
      }
    }
  });

  it('Platform.plans.confirm.hiddenBox (the hidden-plan box of the sync)', () => {
    for (const [, catalogue] of CATALOGUES) {
      expect(catalogue.Platform.plans.confirm.hiddenBox).toBeTypeOf('string');
    }
  });
});
