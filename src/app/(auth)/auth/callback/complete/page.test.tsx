import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, createTranslator } from 'next-intl';

import en from '../../../../../../messages/en.json';
import es from '../../../../../../messages/es.json';
import type { CallbackErrorReason } from '@/lib/auth/callback';

/**
 * s9.8 — /auth/callback/complete. The branches (fragment, error,
 * session already open, nothing) are tested on `completeAuthCallback`
 * in `src/lib/auth/callback.test.ts`; here, the first render in every
 * catalogue and that each failure has its sentence in all three.
 */

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { setSession: vi.fn(), getUser: vi.fn() } }),
}));

import AuthCallbackCompletePage from './page';

type Catalogue = typeof en;
const CATALOGUES: Array<[string, Catalogue]> = [
  ['es', es as Catalogue],
  ['en', en],
];
const REASONS: CallbackErrorReason[] = [
  'expired',
  'otherBrowser',
  'invalid',
  'missing',
];

describe('AuthCallbackCompletePage', () => {
  it.each(CATALOGUES)('%s: renders the waiting state', (locale, m) => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} timeZone="UTC" messages={m}>
        <AuthCallbackCompletePage />
      </NextIntlClientProvider>
    );
    expect(html).toContain(m.AuthCallback.title);
    expect(html).toContain('data-slot="auth-card"');
  });

  it.each(CATALOGUES)('%s: a sentence for every failure', (locale, m) => {
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages: m,
      namespace: 'AuthCallback',
      onError: (e) => errors.push(e.message),
    });
    const seen = new Set<string>();
    for (const reason of REASONS) {
      const text = t(`errors.${reason}`);
      expect(text.length).toBeGreaterThan(0);
      seen.add(text);
    }
    // Four different sentences, not one recycled.
    expect(seen.size).toBe(REASONS.length);
    expect(t('requestNewLink').length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
