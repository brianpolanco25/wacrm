import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import { ImpersonationBanner } from './impersonation-banner';

/**
 * Spec §2: the impersonation notice has to be visible and persistent
 * while the session lasts, and carry a way out. No jsdom in this repo
 * (and no new deps), so the banner is rendered to static markup — enough
 * to pin that it names the account being viewed, says so in both
 * catalogues, and offers the exit control.
 */

const SESSION = {
  accountId: 'aaaaaaaa-0000-4000-8000-000000000001',
  accountName: 'Acme Foods',
  expiresAt: '2026-01-01T00:30:00.000Z',
};

function render(
  session: {
    accountId: string;
    accountName: string | null;
    expiresAt: string;
  } | null,
  locale: 'en' | 'ko' = 'en'
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'en' ? en : ko}
    >
      <ImpersonationBanner session={session} />
    </NextIntlClientProvider>
  );
}

describe('ImpersonationBanner', () => {
  it('renders nothing outside a support session', () => {
    // Which is every request but a handful — it sits in the shell of every
    // dashboard page.
    expect(render(null)).toBe('');
  });

  it('names the account being viewed, so "whose data is this" is never a guess', () => {
    const html = render(SESSION);
    expect(html).toContain('Acme Foods');
    expect(html).toContain('as support');
  });

  it('announces itself to assistive technology', () => {
    const html = render(SESSION);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it('offers the way out in the same place as the warning', () => {
    expect(render(SESSION)).toContain('Exit support session');
  });

  it('still renders, with the way out, when the account cannot be named', () => {
    // The target account was deleted mid-session (or the database would
    // not answer). Rendering nothing would leave the operator with a
    // dashboard that 403s everything and no button to escape it.
    const html = render({ ...SESSION, accountName: null });
    expect(html).toContain(en.Impersonation.unknownAccount);
    expect(html).toContain('Exit support session');
    expect(html).not.toContain('Impersonation.');
  });

  it('names the missing account in Korean too (CP6)', () => {
    const html = render({ ...SESSION, accountName: null }, 'ko');
    expect(html).toContain(ko.Impersonation.unknownAccount);
    expect(html).not.toContain('Impersonation.');
  });

  it('is translated, not English-with-a-Korean-shell (CP6)', () => {
    const html = render(SESSION, 'ko');
    expect(html).toContain('Acme Foods');
    expect(html).toContain(ko.Impersonation.exit);
    // A missing key renders as the keypath; this is what catches that.
    expect(html).not.toContain('Impersonation.');
  });
});
