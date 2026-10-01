import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import type { ManagedUsage } from '@/lib/billing/meta-usage';
import {
  MetaUsageCard,
  fetchMetaUsage,
  type DirectUsage,
} from './meta-usage-card';

// s10.5 — the Meta consumption block of Settings → Subscription,
// rendered to static markup (no jsdom) like the rest of the UI tests.

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

const MANAGED: ManagedUsage = {
  metaBilling: 'managed',
  state: 'ok',
  periodStart: '2026-10-01T00:00:00.000Z',
  cutAt: '2026-11-01T00:00:00.000Z',
  asOf: '2026-10-20T12:00:00.000Z',
  paymentMethod: 'manual',
  includedMessages: 7000,
  packageUsed: 7000,
  overageMessages: 1200,
  percent: 100,
  alert: 'full',
  overageByCategory: [
    {
      category: 'service',
      messages: 1200,
      unitPriceUsd: 0.02825,
      chargeUsd: 33.9,
    },
  ],
  uncategorized: 0,
  feeUsd: 1036,
  overageUsd: 33.9,
  estimatedTotalUsd: 1069.9,
  dueAtCutUsd: 1069.9,
  missingRate: null,
};

const DIRECT: DirectUsage = {
  metaBilling: 'direct',
  state: 'ok',
  freeTier: 1000,
  monthStart: '2026-10-01T00:00:00.000Z',
  resetsAt: '2026-11-01T00:00:00.000Z',
  numbers: [
    {
      id: 'cfg-1',
      label: 'Ventas',
      displayPhoneNumber: '+1 809 555 0001',
      used: 850,
      exhausted: false,
      percent: 85,
      alert: 'warn',
    },
    {
      id: 'cfg-2',
      label: null,
      displayPhoneNumber: '+1 809 555 0002',
      used: 1000,
      exhausted: true,
      percent: 100,
      alert: 'full',
    },
  ],
  metaCost: {
    totalUsd: 7.63,
    byCategory: [
      { category: 'marketing', billable: 100, costUsd: 7.4 },
      { category: 'service', billable: 20, costUsd: 0.23 },
    ],
  },
  missingRate: null,
};

describe('managed: «Consumo del ciclo»', () => {
  it('package bar over the 7.000, 100 % notice, overage by category and estimate at the cut-off', () => {
    const html = render(<MetaUsageCard initial={MANAGED} />);
    expect(html).toContain('Consumo del ciclo');
    expect(html).toContain('7000 de 7000');
    expect(html).toContain('data-usage-alert="full"');
    expect(html).toContain('Paquete agotado');
    expect(html).toContain('Servicio');
    expect(html).toContain('US$ 0,02825');
    expect(html).toContain('US$ 33,90');
    expect(html).toContain('Estimado a pagar al corte');
    expect(html).toMatch(/data-estimate="true">US\$ 1069,90/);
    expect(html).toContain('width:100%');
  });

  it('80 % notice before the package runs out', () => {
    const html = render(
      <MetaUsageCard
        initial={{
          ...MANAGED,
          packageUsed: 5600,
          overageMessages: 0,
          percent: 80,
          alert: 'warn',
          overageByCategory: [],
          overageUsd: 0,
          estimatedTotalUsd: 1036,
        }}
      />
    );
    expect(html).toContain('data-usage-alert="warn"');
    expect(html).toContain('Has usado el 80 % del paquete');
    expect(html).not.toContain('Paquete agotado');
  });

  it('PayPal: says only the overage is billed at the cut-off', () => {
    const html = render(
      <MetaUsageCard
        initial={{ ...MANAGED, paymentMethod: 'paypal', dueAtCutUsd: 33.9 }}
      />
    );
    expect(html).toContain('data-paypal-note');
    expect(html).toContain('US$ 33,90');
  });

  it('a missing rate is a «tarifa pendiente» notice, the panel still renders', () => {
    const html = render(
      <MetaUsageCard
        initial={{
          ...MANAGED,
          state: 'rate_pending',
          overageUsd: null,
          estimatedTotalUsd: null,
          dueAtCutUsd: null,
          overageByCategory: [
            {
              category: 'service',
              messages: 1200,
              unitPriceUsd: null,
              chargeUsd: null,
            },
          ],
          missingRate: { market: 'rest_of_latam', category: 'service' },
        }}
      />
    );
    expect(html).toContain('data-rate-pending');
    expect(html).toContain('Tarifa pendiente');
    expect(html).toContain('Pendiente de tarifa');
    expect(html).toContain('7000 de 7000');
  });

  it('no cycle in progress yet: says so instead of a bar', () => {
    const html = render(
      <MetaUsageCard
        initial={{
          ...MANAGED,
          state: 'no_period',
          periodStart: '2026-12-15T00:00:00.000Z',
          packageUsed: 0,
          overageMessages: 0,
          alert: null,
          overageByCategory: [],
          overageUsd: null,
          estimatedTotalUsd: null,
          dueAtCutUsd: null,
        }}
      />
    );
    expect(html).toContain('data-no-period');
    expect(html).toContain('Aún no hay un ciclo en curso');
    expect(html).not.toContain('data-estimate');
  });

  it('no Meta free-quota bar for a managed account', () => {
    const html = render(<MetaUsageCard initial={MANAGED} />);
    expect(html).not.toContain('gratis');
  });

  it('in English too', () => {
    const html = render(<MetaUsageCard initial={MANAGED} />, 'en');
    expect(html).toContain('Usage this cycle');
    expect(html).toContain('Estimated amount due at cut-off');
  });
});

describe('direct: free quota per number and Meta’s cost', () => {
  it('a bar per number with the 80 % and 100 % notices, and the estimated cost', () => {
    const html = render(<MetaUsageCard initial={DIRECT} />);
    expect(html).toContain('Meta: cuota gratis y costo estimado');
    expect(html).toContain('850 de 1000 gratis');
    expect(html).toContain('data-usage-alert="warn"');
    expect(html).toContain('ya usó el 85 %');
    expect(html).toContain('data-usage-alert="full"');
    expect(html).toContain('Cuota gratis agotada');
    expect(html).toMatch(/data-meta-cost="true">US\$ 7,63/);
    expect(html).toContain('Marketing: 100 mensajes cobrados');
  });

  it('a missing rate hides the cost and says why, the quota stays', () => {
    const html = render(
      <MetaUsageCard
        initial={{
          ...DIRECT,
          state: 'rate_pending',
          metaCost: null,
          missingRate: { market: 'north_america', category: 'utility' },
        }}
      />
    );
    expect(html).toContain('data-rate-pending');
    expect(html).not.toContain('data-meta-cost');
    expect(html).toContain('850 de 1000 gratis');
  });
});

describe('fetchMetaUsage', () => {
  it('null on a refused response or garbage, the body otherwise', async () => {
    const forbidden = vi.fn(async () => new Response('{}', { status: 403 }));
    expect(await fetchMetaUsage(forbidden as unknown as typeof fetch)).toBe(
      null
    );
    const garbage = vi.fn(async () => Response.json({ hello: 1 }));
    expect(await fetchMetaUsage(garbage as unknown as typeof fetch)).toBe(null);
    const ok = vi.fn(async () => Response.json(DIRECT));
    expect(await fetchMetaUsage(ok as unknown as typeof fetch)).toEqual(DIRECT);
    expect(ok).toHaveBeenCalledWith('/api/billing/meta-usage', {
      cache: 'no-store',
    });
  });
});

describe('catalogues', () => {
  it('es and en carry the same keys and placeholders for the new texts', () => {
    const placeholders = (s: string) =>
      [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
    const pairs: Array<[Record<string, string>, Record<string, string>]> = [
      [es.Billing.metaUsage, en.Billing.metaUsage],
      [
        es.Broadcasts.wizard.scheduleSend.cost,
        en.Broadcasts.wizard.scheduleSend.cost,
      ],
    ];
    for (const [a, b] of pairs) {
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      for (const key of Object.keys(a)) {
        expect(placeholders(a[key]), key).toEqual(placeholders(b[key]));
      }
    }
  });

  it('the subscription panel mounts the block', () => {
    const source = readFileSync(
      path.join(__dirname, '../settings/subscription-panel.tsx'),
      'utf8'
    );
    expect(source).toContain('<MetaUsageCard />');
  });
});
