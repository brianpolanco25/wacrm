import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import type { CustomerStatement } from '@/lib/billing/statements';
import { StatementsSection } from './statements-section';
import { claimStatementPaid, daysLeft, formatPeriod } from './statement-claim';

// s10.4 — «Estados de cuenta» on /billing, rendered to static markup
// like the rest of the UI tests (no jsdom), plus the «Ya pagué» call and
// the catalogue keys.

type Catalogue = typeof es;

function render(node: React.ReactNode, locale: 'es' | 'en' = 'es'): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={(locale === 'es' ? es : en) as Catalogue}
    >
      {node}
    </NextIntlClientProvider>
  );
}

const ISSUED: CustomerStatement = {
  id: 'st-1',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  status: 'issued',
  issuedAt: '2026-11-01T00:00:00.000Z',
  dueAt: '2026-11-04T00:00:00.000Z',
  paidAt: null,
  claimedPaidAt: null,
  planFeeUsd: 1036,
  usageChargeUsd: 33.9,
  totalUsd: 1069.9,
  includedMessages: 7000,
  messagesTotal: 8200,
  overageMessages: 1200,
  uncategorized: 3,
  lines: [
    {
      number: '+1 809 555 0001',
      category: 'marketing',
      delivered: 7000,
      included: 7000,
      overage: 0,
      unitPriceUsd: 0.185,
      chargeUsd: 0,
    },
    {
      number: '+1 809 555 0001',
      category: 'service',
      delivered: 1200,
      included: 0,
      overage: 1200,
      unitPriceUsd: 0.02825,
      chargeUsd: 33.9,
    },
  ],
};

const PAID_PAYPAL: CustomerStatement = {
  ...ISSUED,
  id: 'st-0',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  status: 'paid',
  paidAt: '2026-10-02T12:00:00.000Z',
  planFeeUsd: 0,
  usageChargeUsd: 18.5,
  totalUsd: 18.5,
  uncategorized: 0,
};

describe('StatementsSection', () => {
  it('shows the breakdown — number, category, delivered, price, amount — and the total', () => {
    const html = render(<StatementsSection initial={[ISSUED]} />);
    expect(html).toContain(es.Billing.statements.title);
    expect(html).toContain('+1 809 555 0001');
    expect(html).toContain(es.Billing.statements.category.service);
    expect(html).toContain('1200');
    expect(html).toContain('US$ 0,02825');
    expect(html).toContain('US$ 33,90');
    expect(html).toMatch(/data-statement-total="true">US\$ 1069,90/);
    expect(html).toContain(es.Billing.statements.status.issued);
    expect(html).toContain('4 nov 2026');
    // The messages without a Meta category are said, not billed.
    expect(html).toContain('3 mensajes entregados sin categoría');
    // «Ya pagué» on the open one.
    expect(html).toContain(es.Billing.statements.claim);
  });

  it('never says billable or the Meta cost (the data does not even carry them)', () => {
    const html = render(<StatementsSection initial={[ISSUED]} />);
    for (const word of ['billable', 'Meta cobr', 'costo', 'margen']) {
      expect(html).not.toContain(word);
    }
  });

  it('a PayPal statement says the fee is PayPal’s, and a paid one has no «Ya pagué»', () => {
    const html = render(<StatementsSection initial={[PAID_PAYPAL]} />);
    expect(html).toContain(es.Billing.statements.feeNone);
    expect(html).toContain(es.Billing.statements.status.paid);
    expect(html).not.toContain(es.Billing.statements.claim);
  });

  it('once «Ya pagué» was sent it says so instead of offering it again', () => {
    const html = render(
      <StatementsSection
        initial={[{ ...ISSUED, claimedPaidAt: '2026-11-03T10:00:00.000Z' }]}
      />
    );
    expect(html).toContain('Avisaste del pago el 3 nov 2026');
    expect(html).not.toContain(`>${es.Billing.statements.claim}<`);
  });

  it('renders nothing for an account with no statements', () => {
    expect(render(<StatementsSection initial={[]} />)).toBe('');
  });

  it('is translated in en', () => {
    const html = render(<StatementsSection initial={[ISSUED]} />, 'en');
    expect(html).toContain(en.Billing.statements.title);
    expect(html).toContain(en.Billing.statements.total);
  });
});

describe('«Ya pagué» and the helpers', () => {
  it('posts to claim-paid and maps the answers', async () => {
    const calls: string[] = [];
    const fake = (status: number, body: unknown) =>
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;

    expect(
      await claimStatementPaid('st-1', null, fake(200, { claimedPaidAt: 'x' }))
    ).toEqual({ kind: 'claimed', claimedPaidAt: 'x' });
    expect(calls[0]).toBe('/api/billing/statements/st-1/claim-paid');
    expect(await claimStatementPaid('st-1', null, fake(409, {}))).toEqual({
      kind: 'error',
      reason: 'notOpen',
    });
    expect(await claimStatementPaid('st-1', null, fake(403, {}))).toEqual({
      kind: 'error',
      reason: 'forbidden',
    });
    expect(await claimStatementPaid('st-1', null, fake(500, {}))).toEqual({
      kind: 'error',
      reason: 'failed',
    });
    const broken = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await claimStatementPaid('st-1', null, broken)).toEqual({
      kind: 'error',
      reason: 'failed',
    });
  });

  it('counts whole days left, never negative', () => {
    const due = '2026-11-04T00:00:00.000Z';
    expect(daysLeft(due, Date.parse('2026-11-01T00:00:00.000Z'))).toBe(3);
    expect(daysLeft(due, Date.parse('2026-11-03T23:00:00.000Z'))).toBe(1);
    expect(daysLeft(due, Date.parse('2026-11-05T00:00:00.000Z'))).toBe(0);
  });

  it('prints the period in UTC days', () => {
    expect(
      formatPeriod('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'es')
    ).toBe('1 oct 2026 – 1 nov 2026');
  });
});

// CP6: every key the two components ask for exists in es AND en.
function keysUsedBy(file: string, from?: string): string[] {
  let src = readFileSync(path.join(__dirname, file), 'utf8');
  // The alert's older rungs read `Billing.*`; only the statement variant
  // (from its own function on) reads `Billing.statementAlert`.
  if (from) src = src.slice(src.indexOf(from));
  return [...src.matchAll(/\bt\(\s*'([^'`]+)'/g)].map((m) => m[1]);
}

function resolve(node: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (acc, part) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[part]
          : undefined,
      node
    );
}

describe('every key exists in es AND en (CP6)', () => {
  it.each([
    [
      'statements-section.tsx',
      '',
      'statements',
      [
        'status.issued',
        'status.paid',
        'status.void',
        'category.service',
        'category.utility',
        'category.marketing',
        'category.authentication',
        'category.authentication_international',
        'claimErrors.notOpen',
        'claimErrors.forbidden',
        'claimErrors.failed',
      ],
    ],
    [
      'billing-status-alert.tsx',
      'export function StatementDueAlert',
      'statementAlert',
      ['claimErrors.notOpen', 'claimErrors.forbidden', 'claimErrors.failed'],
    ],
  ])('%s → Billing.%s', (file, from, ns, extra) => {
    const keys = [...keysUsedBy(file, from || undefined), ...extra];
    expect(keys.length).toBeGreaterThan(3);
    for (const [locale, catalogue] of [
      ['es', es],
      ['en', en],
    ] as const) {
      const scope = (catalogue.Billing as Record<string, unknown>)[ns];
      for (const key of keys) {
        expect(
          resolve(scope, key),
          `messages/${locale}.json is missing Billing.${ns}.${key}`
        ).toBeTypeOf('string');
      }
    }
  });
});
