import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import type {
  DirectBroadcastEstimate,
  ManagedBroadcastEstimate,
  ManagedPricingMissingEstimate,
} from '@/lib/billing/meta-usage';
import {
  BroadcastCostEstimate,
  OverageConsentText,
  canConfirmSend,
  estimateKey,
  estimateStateFor,
  fetchBroadcastEstimate,
  needsOverageConsent,
  templateCategory,
} from './broadcast-cost-estimate';

// s10.5 — the cost of a broadcast on the scheduling step, and the
// explicit confirmation when it generates overage.

function render(node: React.ReactNode, locale: 'es' | 'en' = 'es'): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={(locale === 'es' ? es : en) as typeof es}
    >
      {node}
    </NextIntlClientProvider>
  );
}

const DIRECT: DirectBroadcastEstimate = {
  metaBilling: 'direct',
  recipients: 1000,
  category: 'marketing',
  market: 'rest_of_latam',
  ratePending: false,
  unitUsd: 0.074,
  totalUsd: 74,
};

const MANAGED: ManagedBroadcastEstimate = {
  metaBilling: 'managed',
  recipients: 1000,
  category: 'marketing',
  market: 'rest_of_latam',
  ratePending: false,
  remaining: 500,
  inPackage: 500,
  overage: 500,
  unitPriceUsd: 0.185,
  overageUsd: 92.5,
  pricingMissing: false,
};

const PRICING_MISSING: ManagedPricingMissingEstimate = {
  metaBilling: 'managed',
  recipients: 200,
  category: 'marketing',
  market: 'rest_of_latam',
  pricingMissing: true,
};

describe('the line on the scheduling step', () => {
  it('direct: «{n} destinatarios × tarifa de marketing = US$ {x}»', () => {
    const html = render(<BroadcastCostEstimate estimate={DIRECT} />);
    expect(html).toContain(
      '1000 destinatarios × tarifa de Marketing (US$ 0,074) = US$ 74,00'
    );
  });

  it('direct with no rate: says so (and the send is not blocked)', () => {
    const html = render(
      <BroadcastCostEstimate
        estimate={{
          ...DIRECT,
          ratePending: true,
          unitUsd: null,
          totalUsd: null,
        }}
      />
    );
    expect(html).toContain('data-rate-pending');
    expect(html).toContain('El envío no se bloquea');
  });

  it('managed: how many fit in the package and how many go to overage at what price', () => {
    const html = render(<BroadcastCostEstimate estimate={MANAGED} />);
    expect(html).toContain('500 entran en tu paquete (500 disponibles');
    expect(html).toContain(
      '500 van a excedente a US$ 0,185 por mensaje de Marketing = US$ 92,50'
    );
  });

  it('managed inside the package: no overage', () => {
    const html = render(
      <BroadcastCostEstimate
        estimate={{
          ...MANAGED,
          remaining: 5000,
          inPackage: 1000,
          overage: 0,
          overageUsd: 0,
        }}
      />
    );
    expect(html).toContain('Sin excedente');
  });

  it('managed with the price pending a rate', () => {
    const html = render(
      <BroadcastCostEstimate
        estimate={{
          ...MANAGED,
          unitPriceUsd: null,
          overageUsd: null,
          ratePending: true,
        }}
      />,
      'en'
    );
    expect(html).toContain(
      '500 go to overage; the Marketing price is pending a rate.'
    );
  });
});

describe('explicit confirmation when it generates overage', () => {
  it('only a managed send with overage asks for the tick', () => {
    expect(needsOverageConsent(MANAGED)).toBe(true);
    expect(needsOverageConsent({ ...MANAGED, overage: 0 })).toBe(false);
    expect(needsOverageConsent(DIRECT)).toBe(false);
    expect(needsOverageConsent(null)).toBe(false);
  });

  it('the tick carries the overage and its amount', () => {
    expect(render(<OverageConsentText estimate={MANAGED} />)).toContain(
      'genera 500 mensajes de excedente, unos US$ 92,50'
    );
  });

  it('a managed account without a price set up: no invented split, no tick, says so', () => {
    expect(needsOverageConsent(PRICING_MISSING)).toBe(false);
    const html = render(<BroadcastCostEstimate estimate={PRICING_MISSING} />);
    expect(html).toContain('data-pricing-missing');
    expect(html).toContain('El precio de tu plan aún no está configurado');
    expect(html).not.toContain('excedente a');
    expect(render(<OverageConsentText estimate={PRICING_MISSING} />)).toBe('');
  });
});

describe('fetchBroadcastEstimate', () => {
  it('asks the route with the reach, the number and the category', async () => {
    const doFetch = vi.fn(async () => Response.json(MANAGED));
    const out = await fetchBroadcastEstimate(
      { recipients: 1000, whatsAppConfigId: 'cfg-a', category: 'marketing' },
      doFetch as unknown as typeof fetch
    );
    expect(out).toEqual(MANAGED);
    expect(doFetch).toHaveBeenCalledWith(
      '/api/billing/broadcast-estimate?recipients=1000&category=marketing&whatsappConfigId=cfg-a',
      { cache: 'no-store' }
    );
  });

  it('null on any failure: no line, nothing blocked', async () => {
    const refused = vi.fn(async () => new Response('{}', { status: 500 }));
    expect(
      await fetchBroadcastEstimate(
        { recipients: 1, whatsAppConfigId: null, category: 'marketing' },
        refused as unknown as typeof fetch
      )
    ).toBe(null);
    const thrown = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(
      await fetchBroadcastEstimate(
        { recipients: 1, whatsAppConfigId: null, category: 'marketing' },
        thrown as unknown as typeof fetch
      )
    ).toBe(null);
  });

  it('the template category as the route takes it', () => {
    expect(templateCategory('Marketing')).toBe('marketing');
    expect(templateCategory('Utility')).toBe('utility');
    expect(templateCategory('Authentication')).toBe('authentication');
    expect(templateCategory(undefined)).toBe('marketing');
  });
});

describe('when the dialog may send (step 4)', () => {
  const key = estimateKey({
    recipients: 5000,
    whatsAppConfigId: 'cfg-a',
    category: 'marketing',
  });

  it('while the estimate of this send is in flight: no', () => {
    expect(canConfirmSend(estimateStateFor(null, key, false), true)).toBe(
      false
    );
    // The reach is still being counted.
    expect(
      canConfirmSend(
        estimateStateFor({ key, estimate: DIRECT }, key, true),
        true
      )
    ).toBe(false);
  });

  it('an answer for another number or reach is stale: loading, not the old figure', () => {
    const other = estimateKey({
      recipients: 5000,
      whatsAppConfigId: 'cfg-b',
      category: 'marketing',
    });
    expect(
      estimateStateFor({ key: other, estimate: DIRECT }, key, false)
    ).toEqual({ status: 'loading' });
    expect(
      estimateStateFor(
        {
          key: estimateKey({
            recipients: 10,
            whatsAppConfigId: 'cfg-a',
            category: 'marketing',
          }),
          estimate: DIRECT,
        },
        key,
        false
      ).status
    ).toBe('loading');
  });

  it('with overage: only after the tick', () => {
    const state = estimateStateFor({ key, estimate: MANAGED }, key, false);
    expect(canConfirmSend(state, false)).toBe(false);
    expect(canConfirmSend(state, true)).toBe(true);
  });

  it('a failed estimate never blocks (CP11)', () => {
    const state = estimateStateFor({ key, estimate: null }, key, false);
    expect(state).toEqual({ status: 'failed' });
    expect(canConfirmSend(state, false)).toBe(true);
  });

  it('without overage, direct, or pricing not set up: sends as today', () => {
    for (const estimate of [
      { ...MANAGED, overage: 0, inPackage: 1000 },
      DIRECT,
      PRICING_MISSING,
    ]) {
      expect(
        canConfirmSend(estimateStateFor({ key, estimate }, key, false), false)
      ).toBe(true);
    }
  });

  it('step 4 wires the dialog to canConfirmSend', () => {
    const source = readFileSync(
      path.join(__dirname, 'step4-schedule-send.tsx'),
      'utf8'
    );
    expect(source).toContain('disabled={!canSend}');
    expect(source).toContain('if (open) setOverageConsent(false)');
  });
});
