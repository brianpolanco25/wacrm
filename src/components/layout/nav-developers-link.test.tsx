import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';

/**
 * p8.1: /developers has to be reachable from the places people actually
 * pass through — the sidebar and the header's account menu. No jsdom in
 * this repo, so both are rendered to static markup with the hooks and
 * the Base UI menu stubbed: the menu popup lives in a portal that never
 * renders server-side, so the stub inlines its items to let the test see
 * the links they carry.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: { id: 'u1' },
    profile: { full_name: 'Ada', email: 'ada@example.com', avatar_url: null },
    profileLoading: false,
    account: { name: 'Ada' },
    accountRole: 'owner',
    signOut: () => {},
  }),
}));
vi.mock('@/hooks/use-platform-admin', () => ({
  usePlatformAdmin: () => false,
}));
vi.mock('@/hooks/use-total-unread', () => ({ useTotalUnread: () => 0 }));
vi.mock('@/hooks/use-unread-notifications', () => ({
  useUnreadNotifications: () => 0,
}));
vi.mock('@/components/billing/trial-banner', () => ({
  TrialBanner: () => null,
}));
vi.mock('@/components/layout/mode-toggle', () => ({
  ModeToggle: () => null,
}));

vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      render,
      children,
    }: {
      render?: React.ReactElement;
      children?: React.ReactNode;
    }) =>
      render ? (
        React.cloneElement(render, undefined, children)
      ) : (
        <div>{children}</div>
      ),
  };
});

import { Header } from './header';
import { Sidebar } from './sidebar';

type Catalogue = typeof es;

function render(node: React.ReactElement, messages: Catalogue = es) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="es" timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

/** The `<a>` whose href is exactly `href`, or null. */
function anchor(html: string, href: string): string | null {
  const match = html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>.*?</a>`));
  return match ? match[0] : null;
}

describe('Sidebar → /developers', () => {
  it('lists the developer docs in the bottom block, after Settings', () => {
    const html = render(<Sidebar />);
    const link = anchor(html, '/developers');
    expect(link).not.toBeNull();
    expect(link).toContain(es.Sidebar.developers);
    expect(html.indexOf('href="/settings"')).toBeLessThan(
      html.indexOf('href="/developers"')
    );
  });

  it('opens in the same tab, like the other internal link to the docs', () => {
    const link = anchor(render(<Sidebar />), '/developers');
    expect(link).not.toContain('target=');
  });

  it('labels the item in every catalogue', () => {
    for (const messages of [en, ko] as Catalogue[]) {
      const link = anchor(render(<Sidebar />, messages), '/developers');
      expect(link).toContain(messages.Sidebar.developers);
    }
  });
});

describe('Header account menu → /developers', () => {
  it('offers the API documentation right after Settings', () => {
    const html = render(<Header />);
    const link = anchor(html, '/developers');
    expect(link).not.toBeNull();
    expect(link).toContain(es.Header.menuApiDocs);
    expect(html.indexOf(es.Header.menuSettings)).toBeLessThan(
      html.indexOf(es.Header.menuApiDocs)
    );
  });

  it('labels the item in every catalogue', () => {
    for (const messages of [en, ko] as Catalogue[]) {
      const link = anchor(render(<Header />, messages), '/developers');
      expect(link).toContain(messages.Header.menuApiDocs);
    }
  });
});
