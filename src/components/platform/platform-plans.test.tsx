import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';
import { PLAN_FEATURES, PLAN_LIMIT_KEYS } from '@/lib/billing/plan-catalog';
import { PlatformPlans, type PlatformPlanView } from './platform-plans';

// /platform/plans (s9.3). No jsdom in the repo: the first paint is
// rendered to static markup with a pre-loaded catalogue. What the page
// DOES is tested in the route tests and in `plan-form.test.ts`.

const CATALOGUES = { en, es, ko } as const;

const SYNC = (state: string, id: string | null = null) => ({
  state,
  providerPlanId: id,
  syncedPrice: null,
});

const PLANS: PlatformPlanView[] = [
  {
    id: 'inicio',
    name: 'Inicio',
    description: null,
    priceMonth: 35,
    priceYear: 350,
    limits: {},
    features: [],
    isPublic: true,
    sortOrder: 1,
    sync: {
      month: SYNC('synced', 'P-1') as never,
      year: SYNC('unpublished') as never,
    },
    history: [],
  },
  {
    id: 'pro',
    name: 'Pro',
    description: null,
    priceMonth: 100,
    priceYear: 1000,
    limits: {},
    features: [],
    isPublic: true,
    sortOrder: 2,
    sync: {
      month: SYNC('price_mismatch', 'P-2') as never,
      year: SYNC('unknown', 'P-3') as never,
    },
    history: [],
  },
  {
    id: 'ilimitado',
    name: 'Ilimitado',
    description: null,
    priceMonth: 0,
    priceYear: null,
    limits: {},
    features: [],
    isPublic: false,
    sortOrder: 99,
    sync: {
      month: SYNC('unpublished') as never,
      year: SYNC('unpublished') as never,
    },
    history: [],
  },
];

function render(
  locale: keyof typeof CATALOGUES,
  env: 'sandbox' | 'live' = 'sandbox',
  paypalConfigured = true
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale]}
    >
      <PlatformPlans
        initial={{ providerEnv: env, paypalConfigured, plans: PLANS }}
      />
    </NextIntlClientProvider>
  );
}

describe('PlatformPlans', () => {
  it('lists every plan, the hidden one too', () => {
    const html = render('es');
    for (const id of ['inicio', 'pro', 'ilimitado']) {
      expect(html).toContain(`data-plan-id="${id}"`);
    }
    expect(html).toContain(es.Platform.plans.hidden);
    expect(html).toContain('35.00 USD');
  });

  it('shows the four sync states with the words of the spec (es)', () => {
    const html = render('es');
    expect(html).toContain('Sin publicar');
    expect(html).toContain('Sincronizado');
    expect(html).toContain('Precio desincronizado');
    expect(html).toContain('Verificar');
    expect(html).toContain('data-sync-state="price_mismatch"');
    expect(html).toContain('data-sync-state="unknown"');
  });

  it('offers «Nuevo plan» and a sync button per plan and cycle', () => {
    const html = render('es');
    expect(html).toContain('Nuevo plan');
    expect(html.match(/data-sync-cycle="month"/g)).toHaveLength(3);
    expect(html.match(/data-sync-cycle="year"/g)).toHaveLength(3);
    expect(html).not.toMatch(/Eliminar|Borrar/);
  });

  it('says which PayPal environment it talks to', () => {
    expect(render('es', 'sandbox')).toContain('data-paypal-env="sandbox"');
    const live = render('es', 'live');
    expect(live).toContain('data-paypal-env="live"');
    expect(live).toContain(es.Platform.plans.envName.live);
  });

  it('warns when PayPal is not configured', () => {
    expect(render('en', 'sandbox', false)).toContain(
      en.Platform.plans.paypalMissing
    );
    expect(render('en')).not.toContain(en.Platform.plans.paypalMissing);
  });

  it.each(['en', 'es', 'ko'] as const)('is translated in %s (CP6)', (loc) => {
    const html = render(loc);
    expect(html).toContain(CATALOGUES[loc].Platform.plans.title);
    expect(html).not.toContain('Platform.plans.');
  });
});

describe('PlatformPlans — round 2 hints', () => {
  it('warns next to the sync button that checkout already shows the new price', () => {
    const html = render('es');
    // Pro/month is price_mismatch.
    expect(html).toContain('data-mismatch-hint="month"');
    expect(html).toContain(es.Platform.plans.hint.priceMismatch);
  });

  it('offers «Despublicar» instead of sync for a published cycle whose price is now 0', () => {
    const plans = PLANS.map((p) =>
      p.id === 'ilimitado'
        ? {
            ...p,
            sync: {
              ...p.sync,
              month: SYNC('price_mismatch', 'P-FREE') as never,
            },
          }
        : p
    );
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="es" timeZone="UTC" messages={es}>
        <PlatformPlans
          initial={{ providerEnv: 'sandbox', paypalConfigured: true, plans }}
        />
      </NextIntlClientProvider>
    );
    expect(html).toContain('data-unpublish-cycle="month"');
    expect(html).toContain(es.Platform.plans.unpublish.month);
    expect(html).toContain(es.Platform.plans.hint.freeButPublished);
    // …and no longer a sync button for that cell: 3 plans × 2 − 1.
    expect(html.match(/data-sync-cycle=/g)).toHaveLength(5);
  });
});

describe('Platform.plans catalogue (CP6)', () => {
  function keysUsedBy(file: string): string[] {
    const source = readFileSync(
      path.join(process.cwd(), 'src/components/platform', file),
      'utf8'
    );
    return [
      ...new Set(
        [...source.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)].map((m) => m[1])
      ),
    ];
  }

  function resolve(node: unknown, dotted: string): unknown {
    return dotted
      .split('.')
      .reduce<unknown>(
        (n, part) =>
          n && typeof n === 'object'
            ? (n as Record<string, unknown>)[part]
            : undefined,
        node
      );
  }

  it.each(['en', 'es', 'ko'] as const)(
    'every static key the page asks for exists in %s',
    (loc) => {
      const keys = keysUsedBy('platform-plans.tsx');
      expect(keys.length).toBeGreaterThan(30);
      for (const key of keys) {
        expect(
          resolve(CATALOGUES[loc].Platform.plans, key),
          `messages/${loc}.json is missing Platform.plans.${key}`
        ).toBeTypeOf('string');
      }
    }
  );

  it.each(['en', 'es', 'ko'] as const)(
    'every metric, feature, state and cycle has a label in %s',
    (loc) => {
      const plans = CATALOGUES[loc].Platform.plans as unknown as Record<
        string,
        Record<string, unknown>
      >;
      for (const key of PLAN_LIMIT_KEYS)
        expect(plans.limits[key]).toBeTypeOf('string');
      for (const key of PLAN_FEATURES)
        expect(plans.features[key]).toBeTypeOf('string');
      for (const key of ['unpublished', 'synced', 'price_mismatch', 'unknown'])
        expect(plans.state[key]).toBeTypeOf('string');
      for (const key of ['month', 'year']) {
        expect(plans.cycle[key]).toBeTypeOf('string');
        expect(plans.sync[key]).toBeTypeOf('string');
      }
      for (const key of ['noop', 'created', 'replaced'])
        expect(plans.syncDone[key]).toBeTypeOf('string');
    }
  );

  it('the confirmation says that current customers keep the old price', () => {
    expect(es.Platform.plans.confirm.newPlanRule).toMatch(
      /plan NUEVO en PayPal/
    );
    expect(es.Platform.plans.confirm.newPlanRule).toMatch(
      /clientes actuales siguen/
    );
    expect(en.Platform.plans.confirm.newPlanRule).toMatch(/current customers/);
  });
});
