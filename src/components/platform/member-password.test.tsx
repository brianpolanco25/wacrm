import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import {
  generatePassword,
  OPERATOR_MAX_PASSWORD_LENGTH,
  OPERATOR_MIN_PASSWORD_LENGTH,
} from '@/lib/platform/password-rules';
import { MemberPassword } from './member-password';

// Static markup, like the rest of the panel (no jsdom): the first paint
// of the button in both catalogues. What it posts is tested on the route.

type Catalogue = typeof es;

function render(messages: Catalogue, locale: 'es' | 'en'): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      <MemberPassword accountId="acc-1" userId="user-1" name="Ana" />
    </NextIntlClientProvider>
  );
}

describe('MemberPassword', () => {
  it('shows only the button until it is opened, in both languages', () => {
    expect(render(es, 'es')).toContain('Cambiar contraseña');
    expect(render(en as Catalogue, 'en')).toContain('Change password');
    expect(render(es, 'es')).not.toContain('<input');
  });

  it('has every text it uses in both catalogues', () => {
    const keys = Object.keys(es.Platform).filter((k) =>
      k.startsWith('password')
    );
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(Object.keys(en.Platform)).toContain(key);
    }
  });
});

describe('generatePassword', () => {
  it('is within the length the server accepts, and not repeated', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a.length).toBeGreaterThanOrEqual(OPERATOR_MIN_PASSWORD_LENGTH);
    expect(a.length).toBeLessThanOrEqual(OPERATOR_MAX_PASSWORD_LENGTH);
    expect(a).not.toBe(b);
  });

  it('avoids look-alike characters', () => {
    expect(generatePassword(200)).not.toMatch(/[0O1lI]/);
  });
});
