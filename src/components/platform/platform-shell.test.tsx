import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';

/**
 * s9.1: the operator's panel has its own chrome. Rendered to static
 * markup, same approach as `platform-panel.test.tsx` (no jsdom, no new
 * dependency): it pins which links the nav offers, which it does NOT
 * (no inbox, contacts or pipelines), that the way back to the CRM is
 * there, and that every string is translated in es/en/ko (CP6).
 */

let pathname = '/platform';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));
vi.mock('@/hooks/use-auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    profile: {
      full_name: 'Olga Operadora',
      email: 'olga@example.com',
      avatar_url: null,
    },
    signOut: vi.fn(),
  }),
}));

import { PlatformFrame, platformSectionFor } from './platform-shell';
import { PlatformPlaceholder } from './platform-placeholder';

type Catalogue = typeof es;
const CATALOGUES: Array<['es' | 'en' | 'ko', Catalogue]> = [
  ['es', es],
  ['en', en as Catalogue],
  ['ko', ko as Catalogue],
];

function render(
  node: React.ReactNode,
  locale: 'es' | 'en' | 'ko' = 'es',
  messages: Catalogue = es
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

function frame(path = '/platform', locale: 'es' | 'en' | 'ko' = 'es') {
  pathname = path;
  const messages = CATALOGUES.find(([l]) => l === locale)![1];
  return render(
    <PlatformFrame support={null}>
      <p>contenido</p>
    </PlatformFrame>,
    locale,
    messages
  );
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

describe('PlatformFrame — the operator nav', () => {
  it('offers Resumen, Cuentas, Planes and Operadores, in that order', () => {
    const links = hrefs(frame());
    const nav = links.filter((h) => h.startsWith('/platform'));
    // The logo links to /platform too, before the nav.
    expect(nav).toEqual([
      '/platform',
      '/platform',
      '/platform/accounts',
      '/platform/plans',
      '/platform/operators',
    ]);
  });

  it('has none of the CRM sections', () => {
    const links = hrefs(frame());
    for (const crm of [
      '/inbox',
      '/contacts',
      '/pipelines',
      '/broadcasts',
      '/settings',
    ]) {
      expect(links.some((h) => h.startsWith(crm))).toBe(false);
    }
  });

  it('keeps a way back to the CRM', () => {
    const html = frame();
    expect(hrefs(html)).toContain('/dashboard');
    expect(html).toContain(es.Platform.shell.goToCrm);
  });

  it('renders the page inside the shell', () => {
    expect(frame()).toContain('<p>contenido</p>');
  });

  it('marks the current section and titles the header with it', () => {
    const html = frame('/platform/plans');
    const current = [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)];
    expect(current).toHaveLength(1);
    expect(current[0][0]).toContain('href="/platform/plans"');
    expect(html).toContain(`<h1`);
    expect(html).toMatch(
      new RegExp(`<h1[^>]*>${es.Platform.shell.nav.plans}</h1>`)
    );
  });

  it('shows the operator badge and name, not the CRM brand lockup', () => {
    const html = frame();
    expect(html).toContain(es.Platform.shell.title);
    expect(html).toContain(es.Platform.shell.badge);
    expect(html).toContain('Olga Operadora');
    expect(html).not.toContain(es.Sidebar.title);
  });

  it('uses the navy accent, not the CRM sidebar', () => {
    const html = frame();
    expect(html).toContain('data-platform-nav');
    expect(html).toMatch(/<aside[^>]*class="[^"]*bg-navy/);
  });

  it.each(CATALOGUES)('is translated in %s (CP6)', (locale, messages) => {
    const html = frame('/platform', locale);
    for (const key of ['overview', 'accounts', 'plans', 'operators'] as const) {
      expect(html).toContain(messages.Platform.shell.nav[key]);
    }
    expect(html).toContain(messages.Platform.shell.goToCrm);
    expect(html).toContain(messages.Platform.shell.badge);
  });
});

describe('platformSectionFor', () => {
  it.each([
    ['/platform', 'overview'],
    ['/platform/', 'overview'],
    ['/platform/accounts', 'accounts'],
    ['/platform/plans', 'plans'],
    ['/platform/operators', 'operators'],
    // An account file belongs to «Cuentas».
    ['/platform/aaaaaaaa-0000-4000-8000-000000000001', 'accounts'],
  ])('%s → %s', (path, section) => {
    expect(platformSectionFor(path)).toBe(section);
  });
});

describe('PlatformPlaceholder', () => {
  it('the Resumen shows empty cards that say «coming soon», not zeros', () => {
    const html = render(
      <PlatformPlaceholder
        section="overview"
        cards={['accounts', 'mrr', 'signups', 'delinquent']}
      />
    );
    expect(html).toContain(es.Platform.placeholder.overview.title);
    expect(html.match(/data-placeholder-card=/g)).toHaveLength(4);
    expect(html.split(es.Platform.placeholder.comingSoon).length - 1).toBe(4);
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  it.each(['plans', 'operators'] as const)(
    'the %s page says what it will be',
    (section) => {
      const html = render(<PlatformPlaceholder section={section} />);
      expect(html).toContain(es.Platform.placeholder[section].title);
      expect(html).toContain(es.Platform.placeholder[section].subtitle);
      expect(html).toContain(es.Platform.placeholder.comingSoon);
    }
  );

  it.each(CATALOGUES)('is translated in %s (CP6)', (locale, messages) => {
    const html = render(
      <PlatformPlaceholder section="overview" cards={['mrr']} />,
      locale,
      messages
    );
    expect(html).toContain(messages.Platform.placeholder.overview.title);
    expect(html).toContain(messages.Platform.placeholder.cards.mrr);
    expect(html).toContain(messages.Platform.placeholder.comingSoon);
  });
});
