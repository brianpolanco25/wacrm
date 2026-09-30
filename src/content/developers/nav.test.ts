import { afterEach, describe, expect, it } from 'vitest';

import { instanceDocsLocale, resolveDocsLocale } from './nav';

// s9.9: the docs follow the instance's locale, and Korean is no longer
// one. An instance still built with NEXT_PUBLIC_APP_LOCALE=ko opens the
// documentation in Spanish, like the interface, not in English.

const original = process.env.NEXT_PUBLIC_APP_LOCALE;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_LOCALE;
  else process.env.NEXT_PUBLIC_APP_LOCALE = original;
});

describe('instanceDocsLocale', () => {
  it.each([
    [undefined, 'es'],
    ['es', 'es'],
    ['en', 'en'],
    ['ko', 'es'],
    ['xx', 'es'],
  ])('NEXT_PUBLIC_APP_LOCALE=%s opens the docs in %s', (value, expected) => {
    if (value === undefined) delete process.env.NEXT_PUBLIC_APP_LOCALE;
    else process.env.NEXT_PUBLIC_APP_LOCALE = value;
    expect(instanceDocsLocale()).toBe(expected);
  });

  it('does not accept ?lang=ko', () => {
    delete process.env.NEXT_PUBLIC_APP_LOCALE;
    expect(resolveDocsLocale('ko')).toBe('es');
    expect(resolveDocsLocale('en')).toBe('en');
  });
});
