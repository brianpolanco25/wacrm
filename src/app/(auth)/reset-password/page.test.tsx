import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, createTranslator } from 'next-intl';

import en from '../../../../messages/en.json';
import es from '../../../../messages/es.json';
import type { NewPasswordError } from '@/lib/auth/reset-password';

/**
 * s9.8 — /reset-password. No jsdom in the repo, so the behaviour (no
 * session, mismatch, each destination) is tested on
 * `submitNewPassword` in `src/lib/auth/reset-password.test.ts`; here,
 * that the page renders its first state in every catalogue and that
 * every sentence it can show exists in all three with `{min}` intact.
 */

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('invite=tok&welcome=1'),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getUser: vi.fn(), updateUser: vi.fn() } }),
}));

import ResetPasswordPage from './page';

type Catalogue = typeof en;
const CATALOGUES: Array<[string, Catalogue]> = [
  ['es', es as Catalogue],
  ['en', en],
];

const ERRORS: NewPasswordError[] = [
  'mismatch',
  'tooShort',
  'samePassword',
  'weakPassword',
  'noSession',
  'failed',
];

describe('ResetPasswordPage', () => {
  it.each(CATALOGUES)('%s: renders the session check first', (locale, m) => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} timeZone="UTC" messages={m}>
        <ResetPasswordPage />
      </NextIntlClientProvider>
    );
    expect(html).toContain(m.ResetPassword.checking);
    // The Cabbity card, same shell as /login.
    expect(html).toContain('data-slot="auth-card"');
  });

  it.each(CATALOGUES)('%s: every error and label formats', (locale, m) => {
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages: m,
      namespace: 'ResetPassword',
      onError: (e) => errors.push(e.message),
    });
    for (const key of ERRORS) {
      const text = t(`errors.${key}`, { min: 6 });
      expect(text).not.toContain('ResetPassword');
      expect(text.length).toBeGreaterThan(0);
    }
    expect(t('errors.tooShort', { min: 6 })).toContain('6');
    expect(t('passwordPlaceholder', { min: 6 })).toContain('6');
    for (const key of [
      'titleWelcome',
      'descWelcome',
      'titleReset',
      'descReset',
      'noSessionTitle',
      'noSessionDesc',
      'requestNewLink',
      'backToSignIn',
      'submit',
      'saving',
    ] as const) {
      expect(t(key).length).toBeGreaterThan(0);
    }
    expect(errors).toEqual([]);
  });
});
