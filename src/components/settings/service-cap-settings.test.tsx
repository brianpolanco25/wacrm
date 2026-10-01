import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

import {
  ServiceCapCard,
  ServiceUsageLine,
  saveServiceCapAction,
} from './service-cap-settings';
import type {
  ServiceCapNumber,
  ServiceCapStatus,
} from '@/hooks/use-service-cap';

// p11.3 R17 (línea de uso por número) y R18 (tarjeta del ajuste).
// Sin jsdom en el repo: el render es estático y el guardado se prueba
// a través de `saveServiceCapAction`, que es lo que llama el cambio de
// opción (PATCH con el cuerpo exacto, y revertir si falla).

type Catalogue = typeof es;
const w = es.Settings.whatsapp.serviceCap;

function num(over: Partial<ServiceCapNumber> = {}): ServiceCapNumber {
  return {
    id: 'cfg-1',
    label: 'Ventas',
    displayPhoneNumber: '+1 809 555 0101',
    used: 0,
    billable: 0,
    exhausted: false,
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

function wrap(node: React.ReactNode, messages: Catalogue = es, locale = 'es') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('ServiceUsageLine (R17)', () => {
  const line = (
    n: ServiceCapNumber | undefined,
    metaBilling: 'direct' | 'managed' | undefined = 'direct',
    messages: Catalogue = es,
    locale = 'es'
  ) =>
    wrap(
      <ServiceUsageLine number={n} freeTier={1000} metaBilling={metaBilling} />,
      messages,
      locale
    );

  it('0 used', () => {
    const html = line(num());
    expect(html).toContain('Mensajes de servicio este mes: 0 de 1000 gratis');
    expect(html).not.toContain(w.exhausted);
  });

  it('734 used', () => {
    expect(line(num({ used: 734 }))).toContain('734 de 1000 gratis');
  });

  it('exhausted by count shows the tag', () => {
    const html = line(num({ used: 1000, exhausted: true }));
    expect(html).toContain(w.exhausted);
  });

  it('exhausted by billable with a low count shows the tag too', () => {
    const html = line(num({ used: 12, billable: 1, exhausted: true }));
    expect(html).toContain('12 de 1000');
    expect(html).toContain(w.exhausted);
  });

  it('managed, unknown billing or no data → nothing', () => {
    expect(line(num(), 'managed')).toBe('');
    expect(
      wrap(
        <ServiceUsageLine
          number={num()}
          freeTier={1000}
          metaBilling={undefined}
        />
      )
    ).toBe('');
    expect(line(undefined)).toBe('');
  });

  it('English', () => {
    expect(line(num({ used: 734 }), 'direct', en, 'en')).toContain(
      'Service messages this month: 734 of 1,000 free'
    );
  });
});

function radio(html: string, value: string): string {
  const m = new RegExp(`<[^>]*id="service-cap-${value}"[^>]*>`).exec(html);
  if (!m) throw new Error(`no radio ${value}`);
  return m[0];
}

describe('ServiceCapCard (R18)', () => {
  const card = (s: ServiceCapStatus | null, canEdit = true) =>
    wrap(<ServiceCapCard status={s} canEdit={canEdit} />);

  it('shows both options with the current one checked', () => {
    const html = card(status({ action: 'pause_ai' }));
    expect(html).toContain(w.cardTitle);
    expect(html).toContain('Meta regala 1000 mensajes');
    expect(html).toContain(w.warn);
    expect(html).toContain(w.pauseAi);
    expect(radio(html, 'pause_ai')).toMatch(/\schecked=""/);
    expect(radio(html, 'warn')).not.toMatch(/\schecked=""/);
  });

  it('warn checked by default', () => {
    const html = card(status());
    expect(radio(html, 'warn')).toMatch(/\schecked=""/);
  });

  it('disabled without permission', () => {
    const html = card(status(), false);
    expect(radio(html, 'warn')).toMatch(/\sdisabled=""/);
    expect(radio(html, 'pause_ai')).toMatch(/\sdisabled=""/);
  });

  it('enabled with permission', () => {
    const html = card(status(), true);
    expect(radio(html, 'warn')).not.toMatch(/\sdisabled=""/);
  });

  it('hidden for managed, without data or without numbers', () => {
    expect(card(status({ metaBilling: 'managed' }))).toBe('');
    expect(card(null)).toBe('');
    expect(card(status({ numbers: [] }))).toBe('');
  });
});

describe('saveServiceCapAction (R18: PATCH and revert)', () => {
  it('sends a PATCH with the exact body and keeps the new action', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ action: 'pause_ai' }), { status: 200 })
    );
    const out = await saveServiceCapAction(
      'pause_ai',
      'warn',
      fetchImpl as unknown as typeof fetch
    );
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      '/api/whatsapp/service-cap',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause_ai' }),
      }
    );
    expect(out).toEqual({ ok: true, action: 'pause_ai' });
  });

  it('a non-OK response reverts to the previous action', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"x"}', { status: 403 })
    );
    expect(
      await saveServiceCapAction(
        'pause_ai',
        'warn',
        fetchImpl as unknown as typeof fetch
      )
    ).toEqual({ ok: false, action: 'warn' });
  });

  it('a network error reverts too', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect(
      await saveServiceCapAction(
        'warn',
        'pause_ai',
        fetchImpl as unknown as typeof fetch
      )
    ).toEqual({ ok: false, action: 'pause_ai' });
  });
});
