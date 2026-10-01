import { describe, expect, it } from 'vitest';

import {
  BILLING_EMAIL_KINDS,
  billingUrl,
  renderBillingEmail,
  type BillingEmailParams,
} from './billing-templates';

// p11.7, R22–R24. Texto plano desde `Emails.billing` en es y en.

const QUOTA = {
  number: 'Ventas RD',
  used: 850,
  limit: 1000,
  monthStart: '2026-10-01T00:00:00.000Z',
};
const STATEMENT = {
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  totalUsd: 1037.85,
  dueAt: '2026-11-04T00:00:00.000Z',
};

function paramsFor(
  kind: (typeof BILLING_EMAIL_KINDS)[number]
): BillingEmailParams {
  return kind === 'service_quota_80' || kind === 'service_quota_100'
    ? { kind, ...QUOTA }
    : { kind, ...STATEMENT };
}

describe.each(['es', 'en'] as const)(
  'renderBillingEmail in %s (R22)',
  (locale) => {
    it.each(BILLING_EMAIL_KINDS)(
      '%s: no stray braces, no raw keypaths, values substituted',
      (kind) => {
        const { subject, text } = renderBillingEmail(paramsFor(kind), locale);
        for (const s of [subject, text]) {
          expect(s).not.toMatch(/[{}]/);
          expect(s).not.toContain('Emails.billing');
          expect(s).not.toContain(kind);
          expect(s.length).toBeGreaterThan(20);
        }
        expect(subject).toContain('Cabbity CRM');
        if (kind.startsWith('service_quota')) {
          expect(`${subject} ${text}`).toContain('Ventas RD');
          expect(text).toMatch(/1[.,]?000/);
        } else {
          expect(text).toMatch(/1[.,]?037[.,]85/);
          expect(text).toContain('2026');
          expect(text).toContain('UTC');
        }
      }
    );
  }
);

describe('exact text in es (R24)', () => {
  it('service_quota_80 names the number, the used, the limit and the month', () => {
    expect(
      renderBillingEmail({ kind: 'service_quota_80', ...QUOTA }, 'es')
    ).toEqual({
      subject:
        'Cabbity CRM: Ventas RD lleva 850 de sus 1000 mensajes de servicio gratis',
      text: 'Tu número de WhatsApp Ventas RD ya usó 850 de los 1000 mensajes de servicio que Meta entrega gratis cada mes (octubre de 2026). Después de 1000, Meta cobra cada mensaje de servicio a tarifa de utilidad hasta que acabe el mes.',
    });
  });

  it('service_quota_100', () => {
    expect(
      renderBillingEmail(
        { kind: 'service_quota_100', ...QUOTA, used: 1000 },
        'es'
      )
    ).toEqual({
      subject:
        'Cabbity CRM: Ventas RD agotó sus mensajes de servicio gratis de octubre de 2026',
      text: 'Tu número de WhatsApp Ventas RD ya usó los 1000 mensajes de servicio gratis de octubre de 2026. Desde ahora y hasta que acabe el mes, Meta cobra cada mensaje de servicio a tarifa de utilidad en tu método de pago.',
    });
  });

  it('statement_issued: period, US$ with two decimals and the due date in UTC', () => {
    expect(
      renderBillingEmail({ kind: 'statement_issued', ...STATEMENT }, 'es')
    ).toEqual({
      subject:
        'Cabbity CRM: tu estado de cuenta de 1 de octubre de 2026 – 1 de noviembre de 2026 está listo',
      text: 'Tu estado de cuenta de 1 de octubre de 2026 – 1 de noviembre de 2026 es de US$ 1037,85 y vence el 4 de noviembre de 2026 a las 0:00 UTC. Si no está pagado para entonces, la cuenta pasa a solo lectura: seguirás recibiendo y leyendo mensajes, pero no podrás enviarlos.',
    });
  });

  it('statement_due', () => {
    expect(
      renderBillingEmail(
        { kind: 'statement_due', ...STATEMENT, totalUsd: 18.5 },
        'es'
      )
    ).toEqual({
      subject:
        'Cabbity CRM: tu estado de cuenta de 1 de octubre de 2026 – 1 de noviembre de 2026 está vencido',
      text: 'Tu estado de cuenta de 1 de octubre de 2026 – 1 de noviembre de 2026 por US$ 18,50 venció el 4 de noviembre de 2026 a las 0:00 UTC y no consta como pagado. La cuenta está en solo lectura: los mensajes entrantes se siguen recibiendo, pero no se puede enviar nada hasta que se confirme el pago.',
    });
  });

  it('the month and the dates are UTC, not the machine’s zone', () => {
    // 1 de noviembre 00:30 UTC sigue siendo noviembre aunque en RD (UTC−4)
    // fuera 31 de octubre.
    const { text } = renderBillingEmail(
      {
        kind: 'service_quota_100',
        ...QUOTA,
        monthStart: '2026-11-01T00:30:00.000Z',
      },
      'es'
    );
    expect(text).toContain('noviembre de 2026');
  });
});

describe('the link line (R23)', () => {
  it.each([
    ['https://crm.example.com', 'https://crm.example.com/billing'],
    ['https://crm.example.com/', 'https://crm.example.com/billing'],
    ['https://crm.example.com///', 'https://crm.example.com/billing'],
  ])('site %s → %s', (site, url) => {
    const { text } = renderBillingEmail(
      { kind: 'statement_issued', ...STATEMENT },
      'es',
      site
    );
    expect(text.endsWith(`\n\nDetalles: ${url}`)).toBe(true);
    expect(text).not.toContain('//billing');
  });

  it('in en the line says Details', () => {
    const { text } = renderBillingEmail(
      { kind: 'service_quota_80', ...QUOTA },
      'en',
      'https://crm.example.com'
    );
    expect(text.endsWith('\n\nDetails: https://crm.example.com/billing')).toBe(
      true
    );
  });

  it.each([undefined, null, '', '   '])('no site (%s) → no link', (site) => {
    const { text } = renderBillingEmail(
      { kind: 'statement_issued', ...STATEMENT },
      'es',
      site
    );
    expect(text).not.toContain('Detalles');
    expect(text).not.toContain('http');
    expect(billingUrl(site)).toBeNull();
  });
});
