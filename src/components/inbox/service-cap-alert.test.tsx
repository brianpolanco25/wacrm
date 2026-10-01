import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

import { ServiceCapAlert } from './service-cap-alert';
import type {
  ServiceCapNumber,
  ServiceCapStatus,
} from '@/hooks/use-service-cap';

// p11.3 R16 (franja de la bandeja) y R19 (paridad es/en de las claves
// nuevas). Sin jsdom en el repo: render estático, como el resto de
// componentes.

type Catalogue = typeof es;

function num(over: Partial<ServiceCapNumber> = {}): ServiceCapNumber {
  return {
    id: 'cfg-1',
    label: 'Ventas',
    displayPhoneNumber: '+1 809 555 0101',
    used: 1000,
    billable: 0,
    exhausted: true,
    ...over,
  };
}

function status(over: Partial<ServiceCapStatus> = {}): ServiceCapStatus {
  return {
    metaBilling: 'direct',
    action: 'warn',
    freeTier: 1000,
    monthStart: '2026-10-01T00:00:00.000Z',
    resetsAt: '2026-11-01T00:00:00.000Z',
    numbers: [num()],
    ...over,
  };
}

function render(
  s: ServiceCapStatus | null,
  messages: Catalogue = es,
  locale: 'es' | 'en' = 'es'
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      <ServiceCapAlert status={s} />
    </NextIntlClientProvider>
  );
}

describe('ServiceCapAlert (R16)', () => {
  it('exhausted + warn: names the number, says Meta charges and the AI keeps replying', () => {
    const html = render(status());
    expect(html).toContain('data-service-cap-alert');
    expect(html).toContain(es.Inbox.serviceCap.title);
    expect(html).toContain('Ventas');
    expect(html).toContain('Meta cobra');
    expect(html).toContain(es.Inbox.serviceCap.warnOnly);
    expect(html).not.toContain('hasta el');
    // Sin botón de cerrar.
    expect(html).not.toContain('<button');
  });

  it('exhausted + pause_ai: says the AI is paused until the reset date', () => {
    const html = render(status({ action: 'pause_ai' }));
    expect(html).toContain('La IA no responde sola');
    expect(html).toContain('1 de noviembre de 2026');
    expect(html).not.toContain(es.Inbox.serviceCap.warnOnly);
  });

  it('pause_ai in English formats the date in English', () => {
    const html = render(status({ action: 'pause_ai' }), en, 'en');
    expect(html).toContain('November 1, 2026');
    expect(html).toContain('this number');
  });

  it('two exhausted numbers are both named; a number under the tier is not', () => {
    const html = render(
      status({
        numbers: [
          num(),
          num({
            id: 'cfg-2',
            label: null,
            displayPhoneNumber: '+1 809 555 0202',
          }),
          num({ id: 'cfg-3', label: 'Soporte', used: 10, exhausted: false }),
        ],
      })
    );
    expect(html).toContain('Ventas, +1 809 555 0202');
    expect(html).not.toContain('Soporte');
    expect(html).toContain('estos números');
  });

  it('managed → nothing', () => {
    expect(render(status({ metaBilling: 'managed' }))).toBe('');
  });

  it('null (no data / failed read, R8) → nothing', () => {
    expect(render(null)).toBe('');
  });

  it('no exhausted number → nothing', () => {
    expect(
      render(status({ numbers: [num({ used: 999, exhausted: false })] }))
    ).toBe('');
  });
});

// ------------------------------------------------------------
// R19 — the new keys exist in both catalogues with the same
// placeholders.
// ------------------------------------------------------------

function placeholders(msg: string): string[] {
  // Top-level ICU argument names: `{name}` or `{name, type, ...}`.
  const out = new Set<string>();
  let depth = 0;
  for (let i = 0; i < msg.length; i++) {
    const ch = msg[i];
    if (ch === '{') {
      if (depth === 0) {
        const m = /^\{\s*([a-zA-Z_][\w]*)/.exec(msg.slice(i));
        if (m) out.add(m[1]);
      }
      depth++;
    } else if (ch === '}') {
      depth--;
    }
  }
  return [...out].sort();
}

function leaves(obj: Record<string, unknown>, prefix = ''): [string, string][] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'string'
      ? [[`${prefix}${k}`, v] as [string, string]]
      : leaves(v as Record<string, unknown>, `${prefix}${k}.`)
  );
}

describe('i18n parity of the p11.3 keys (R19)', () => {
  const groups: Array<[string, (c: Catalogue) => Record<string, unknown>]> = [
    ['Inbox.serviceCap', (c) => c.Inbox.serviceCap],
    ['Settings.whatsapp.serviceCap', (c) => c.Settings.whatsapp.serviceCap],
  ];

  it.each(groups)('%s has the same keys in es and en', (_name, pick) => {
    const esKeys = leaves(pick(es))
      .map(([k]) => k)
      .sort();
    const enKeys = leaves(pick(en))
      .map(([k]) => k)
      .sort();
    expect(esKeys.length).toBeGreaterThan(0);
    expect(enKeys).toEqual(esKeys);
  });

  it.each(groups)(
    '%s has the same placeholders in es and en',
    (_name, pick) => {
      const enMap = new Map(leaves(pick(en)));
      for (const [key, esMsg] of leaves(pick(es))) {
        expect([key, placeholders(enMap.get(key) ?? '')]).toEqual([
          key,
          placeholders(esMsg),
        ]);
      }
    }
  );

  it('the design keys are all there', () => {
    expect(Object.keys(es.Inbox.serviceCap).sort()).toEqual(
      ['numbers', 'paused', 'title', 'warnOnly'].sort()
    );
    for (const k of [
      'usage',
      'exhausted',
      'cardTitle',
      'cardDesc',
      'warn',
      'warnDesc',
      'pauseAi',
      'pauseAiDesc',
      'saveFailed',
    ]) {
      expect(es.Settings.whatsapp.serviceCap).toHaveProperty(k);
    }
  });
});
