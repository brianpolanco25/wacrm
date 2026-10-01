import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import type { PlatformMetrics } from '@/lib/platform/metrics';
import {
  formatUsd,
  PlatformOverview,
  PlatformOverviewView,
  type OverviewState,
} from './platform-overview';

// s9.2: the Resumen of the operator console. Rendered to static markup,
// like the rest of the panel's tests (no jsdom, no new dependency): the
// container is pinned on its first paint (loading, never zeros) and the
// view on each of its three states.

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

const METRICS: PlatformMetrics = {
  generatedAt: '2026-09-30T12:00:00Z',
  accounts: {
    total: 12,
    byStatus: { active: 5, past_due: 1, suspended: 2, none: 3, weird: 1 },
  },
  signups: {
    last7Days: 2,
    last30Days: 9,
    weekly: Array.from({ length: 12 }, (_, i) => ({
      weekStart: new Date(Date.UTC(2026, 6, 6 + 7 * i))
        .toISOString()
        .slice(0, 10),
      count: i === 5 ? 0 : i + 1,
    })),
  },
  revenue: { mrrUsd: 1234.5, arrUsd: 14814, payingAccounts: 6 },
  comped: 1,
  delinquent: { pastDue: 1, suspended: 2, total: 3 },
  whatsapp: { connected: 4 },
  messagesMonth: { periodStart: '2026-09-01', inbound: 321, outbound: 123 },
};

const ready: OverviewState = { kind: 'ready', metrics: METRICS };

function metricCard(html: string, id: string): string {
  const start = html.indexOf(`data-metric="${id}"`);
  expect(start, `card ${id} is missing`).toBeGreaterThan(-1);
  const next = html.indexOf('data-metric="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

describe('PlatformOverview, first paint', () => {
  it('opens on the loading state — no card, no zero, no «$0»', () => {
    const html = render(<PlatformOverview />);
    expect(html).toContain(es.Platform.metrics.loading);
    expect(html).toContain('data-overview-state="loading"');
    expect(html).not.toContain('data-metric=');
    expect(html).not.toMatch(/\$\s?0|0\s?US\$/);
  });
});

describe('PlatformOverviewView', () => {
  it('says so out loud when the load failed, and shows no figures', () => {
    const html = render(
      <PlatformOverviewView state={{ kind: 'error' }} onRetry={() => {}} />
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(es.Platform.metrics.loadFailed);
    expect(html).toContain(es.Platform.metrics.refresh);
    expect(html).not.toContain('data-metric=');
  });

  it('has every card of the Resumen', () => {
    const html = render(<PlatformOverviewView state={ready} />);
    for (const id of [
      'accounts',
      'mrr',
      'arr',
      'comped',
      'signups',
      'delinquent',
      'whatsapp',
      'messages',
      'by-status',
      'weekly',
    ]) {
      metricCard(html, id);
    }
  });

  it('shows the money in USD (MRR, ARR), in the operator locale', () => {
    const html = render(<PlatformOverviewView state={ready} />, 'en', en);
    expect(metricCard(html, 'mrr')).toContain('$1,234.50');
    expect(metricCard(html, 'arr')).toContain('$14,814');
    expect(metricCard(html, 'mrr')).toContain('6 paying accounts');
  });

  it('shows comped apart, and the rest of the counts', () => {
    const html = render(<PlatformOverviewView state={ready} />, 'en', en);
    expect(metricCard(html, 'comped')).toContain('>1<');
    expect(metricCard(html, 'comped')).toContain(
      en.Platform.metrics.compedHint
    );
    expect(metricCard(html, 'accounts')).toContain('>12<');
    expect(metricCard(html, 'signups')).toContain('2 / 9');
    expect(metricCard(html, 'delinquent')).toContain('>3<');
    expect(metricCard(html, 'delinquent')).toContain(
      '1 past due · 2 suspended'
    );
    expect(metricCard(html, 'whatsapp')).toContain('>4<');
    expect(metricCard(html, 'messages')).toContain('321 / 123');
  });

  it('lists accounts by status, translated, with unknown statuses verbatim', () => {
    const html = render(<PlatformOverviewView state={ready} />);
    const card = metricCard(html, 'by-status');
    expect(card).toContain(es.Platform.metrics.status.active);
    expect(card).toContain(es.Platform.metrics.status.none);
    expect(card).toContain(es.Platform.metrics.status.past_due);
    expect(card).toContain('data-status="weird"');
    expect(card).toContain('>weird<');
  });

  it('draws twelve weekly bars in its own SVG, heights proportional to the count', () => {
    const html = render(<PlatformOverviewView state={ready} />, 'en', en);
    const card = metricCard(html, 'weekly');
    expect(card).toContain('<svg');
    expect(card.match(/data-week="/g)).toHaveLength(12);
    // A zero week has a hit target and a tooltip but no bar.
    expect(card.match(/class="fill-primary"/g)).toHaveLength(11);
    // Tallest bar is the max (12): full height minus the 4px headroom.
    expect(card).toMatch(/height="116" rx="4"/);
    // Hover tooltip and the text alternative.
    expect(card).toContain('<title>Week of');
    expect(card).toContain('<div class="sr-only"><table>');
    expect(card).toContain('<caption>');
  });

  it('never puts sr-only on a <table> itself, only on its wrapper (s9.11)', () => {
    // A <table> ignores sr-only's 1px height/overflow clip; absolutely
    // positioned, it stretched the document and made /platform scroll.
    const html = render(<PlatformOverviewView state={ready} />, 'en', en);
    expect(html).toContain('<table>');
    expect(html).not.toMatch(/<table[^>]*class="[^"]*sr-only/);
    expect(html).toMatch(/<div class="sr-only"><table>/);
  });

  it('says there is no data rather than drawing an empty chart', () => {
    const html = render(
      <PlatformOverviewView
        state={{
          kind: 'ready',
          metrics: { ...METRICS, signups: { ...METRICS.signups, weekly: [] } },
        }}
      />
    );
    expect(metricCard(html, 'weekly')).toContain(es.Platform.metrics.noSignups);
  });

  it.each(CATALOGUES)('is translated in %s (CP6)', (locale, messages) => {
    const html = render(
      <PlatformOverviewView state={ready} />,
      locale,
      messages
    );
    expect(html).toContain(messages.Platform.metrics.title);
    expect(html).toContain(messages.Platform.metrics.cards.mrr);
    expect(html).toContain(messages.Platform.metrics.weeklyTitle);
    if (locale !== 'en') {
      expect(html).not.toContain(en.Platform.metrics.cards.mrr);
    }
  });
});

describe('Platform.metrics catalogue (CP6)', () => {
  it('every key the component asks for exists in es AND en', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/components/platform/platform-overview.tsx'),
      'utf8'
    );
    const keys = new Set<string>();
    for (const match of source.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) {
      keys.add(match[1]);
    }
    expect(keys.size).toBeGreaterThan(15);
    for (const [, catalogue] of CATALOGUES) {
      for (const key of keys) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, part) =>
              node && typeof node === 'object'
                ? (node as Record<string, unknown>)[part]
                : undefined,
            catalogue.Platform.metrics
          );
        expect(value, `Platform.metrics.${key}`).toBeTypeOf('string');
      }
    }
  });
});

describe('formatUsd', () => {
  it('formats USD whatever the locale, with cents only when there are cents', () => {
    expect(formatUsd(200, 'en')).toBe('$200');
    expect(formatUsd(1234.5, 'en')).toBe('$1,234.50');
    expect(formatUsd(0, 'en')).toBe('$0');
    expect(formatUsd(100, 'es')).toMatch(/100/);
    expect(formatUsd(100, 'es')).toMatch(/US\$|\$/);
  });
});
