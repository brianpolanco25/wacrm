import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../../messages/en.json';
import es from '../../../../messages/es.json';
import ko from '../../../../messages/ko.json';

/**
 * p8.1 §3: the login footer points developers at the public API docs,
 * so someone who lands here without an account can still find them.
 */

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithPassword: vi.fn() } }),
}));

import LoginPage from './page';

type Catalogue = typeof es;

function render(messages: Catalogue = es) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="es" timeZone="UTC" messages={messages}>
      <LoginPage />
    </NextIntlClientProvider>
  );
}

describe('LoginPage → /developers', () => {
  it('links the developer API below the sign-up prompt', () => {
    const html = render();
    const link = html.match(/<a[^>]*href="\/developers"[^>]*>.*?<\/a>/);
    expect(link?.[0]).toContain(es.LoginPage.developersLink);
    expect(html.indexOf('href="/signup"')).toBeLessThan(
      html.indexOf('href="/developers"')
    );
  });

  it('labels the link in every catalogue', () => {
    for (const messages of [en, ko] as Catalogue[]) {
      expect(render(messages)).toContain(messages.LoginPage.developersLink);
    }
  });
});
