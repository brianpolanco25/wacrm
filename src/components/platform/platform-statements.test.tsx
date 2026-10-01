import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import type { PlatformStatement } from '@/lib/platform/statements';
import {
  PlatformStatements,
  settleStatementRequest,
} from './platform-statements';

// s10.4 — «Estados de cuenta» on the operator's file. First paint with
// the internal figures, the two acts only on an open statement, the
// request helper, and the catalogue keys.

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

const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';

const OPEN: PlatformStatement = {
  id: 'st-1',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  status: 'issued',
  issuedAt: '2026-11-01T00:00:00.000Z',
  dueAt: '2026-11-04T00:00:00.000Z',
  paidAt: null,
  paidBy: null,
  paidReference: null,
  paidNote: null,
  claimedPaidAt: '2026-11-03T10:00:00.000Z',
  claimNote: 'transferí ayer',
  planFeeUsd: 1036,
  usageChargeUsd: 33.9,
  totalUsd: 1069.9,
  metaCostUsd: 520.26,
  marginUsd: 549.64,
  includedMessages: 7000,
  messagesTotal: 8200,
  overageMessages: 1200,
  uncategorized: { total: 2, byCategory: { marketing_lite: 2 } },
  lines: [],
};

const PAID: PlatformStatement = {
  ...OPEN,
  id: 'st-0',
  status: 'paid',
  paidAt: '2026-10-02T12:00:00.000Z',
  paidReference: 'TRX-9',
  claimedPaidAt: null,
  claimNote: null,
  uncategorized: { total: 0, byCategory: {} },
};

describe('PlatformStatements', () => {
  it('shows the total, status, due date, real cost, margin, uncategorized and the «Ya pagué» note', () => {
    const html = render(
      <PlatformStatements accountId={ACCOUNT} initial={[OPEN]} />
    );
    expect(html).toContain(es.Platform.statements.title);
    expect(html).toContain('US$ 1069,90');
    expect(html).toContain(es.Platform.statements.status.issued);
    expect(html).toContain('vence el 4 nov 2026');
    expect(html).toContain('costo de Meta US$ 520,26');
    expect(html).toContain('margen US$ 549,64');
    expect(html).toContain('marketing_lite: 2');
    expect(html).toContain(
      'El cliente avisó que pagó el 3 nov 2026: transferí ayer'
    );
    expect(html).toContain(es.Platform.statements.confirm);
    expect(html).toContain(es.Platform.statements.void);
  });

  it('a paid statement shows its reference and offers no act', () => {
    const html = render(
      <PlatformStatements accountId={ACCOUNT} initial={[PAID]} />
    );
    expect(html).toContain('referencia TRX-9');
    expect(html).not.toContain(es.Platform.statements.confirm);
    expect(html).not.toContain(`>${es.Platform.statements.void}<`);
  });

  it('says so when there are none', () => {
    expect(
      render(<PlatformStatements accountId={ACCOUNT} initial={[]} />)
    ).toContain(es.Platform.statements.none);
  });

  it('is translated in en', () => {
    const html = render(
      <PlatformStatements accountId={ACCOUNT} initial={[OPEN]} />,
      'en'
    );
    expect(html).toContain(en.Platform.statements.confirm);
    expect(html).toContain('Meta cost US$ 520.26');
  });
});

describe('settleStatementRequest', () => {
  const fake = (status: number, body: unknown) =>
    vi.fn(
      async () => new Response(JSON.stringify(body), { status })
    ) as unknown as typeof fetch;

  it('posts to the act and maps every answer', async () => {
    const ok = fake(200, {});
    expect(
      await settleStatementRequest(ACCOUNT, 'st-1', 'confirm', {}, ok)
    ).toEqual({ kind: 'done' });
    expect((ok as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `/api/platform/accounts/${ACCOUNT}/statements/st-1/confirm`
    );
    expect(
      await settleStatementRequest(ACCOUNT, 'st-1', 'void', {}, fake(409, {}))
    ).toEqual({ kind: 'error', reason: 'notOpen' });
    expect(
      await settleStatementRequest(ACCOUNT, 'st-1', 'void', {}, fake(404, {}))
    ).toEqual({ kind: 'error', reason: 'notFound' });
    expect(
      await settleStatementRequest(
        ACCOUNT,
        'st-1',
        'void',
        {},
        fake(400, { error: 'reason is required' })
      )
    ).toEqual({
      kind: 'error',
      reason: 'invalid',
      detail: 'reason is required',
    });
    expect(
      await settleStatementRequest(ACCOUNT, 'st-1', 'void', {}, fake(500, {}))
    ).toEqual({ kind: 'error', reason: 'failed' });
  });
});

describe('every key exists in es AND en (CP6)', () => {
  it('Platform.statements', () => {
    const src = readFileSync(
      path.join(__dirname, 'platform-statements.tsx'),
      'utf8'
    );
    const keys = [
      ...[...src.matchAll(/\bt\(\s*'([^'`]+)'/g)].map((m) => m[1]),
      'status.issued',
      'status.paid',
      'status.void',
      'errors.notOpen',
      'errors.notFound',
      'errors.failed',
    ];
    expect(keys.length).toBeGreaterThan(20);
    for (const [locale, catalogue] of [
      ['es', es],
      ['en', en],
    ] as const) {
      const ns = (catalogue.Platform as Record<string, unknown>)
        .statements as Record<string, unknown>;
      for (const key of keys) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (acc, part) =>
              acc && typeof acc === 'object'
                ? (acc as Record<string, unknown>)[part]
                : undefined,
            ns
          );
        expect(
          value,
          `messages/${locale}.json is missing Platform.statements.${key}`
        ).toBeTypeOf('string');
      }
    }
  });
});
