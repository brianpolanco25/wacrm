import { afterEach, describe, expect, it, vi } from 'vitest';
import getConfig, { DEFAULT_LOCALE, LOCALES, resolveLocale } from './request';

// next-intl's `getRequestConfig` is the identity function (it exists for
// typing), so the default export of request.ts is the config callback
// itself and can be called straight from a test. The locale is read from
// the environment on every call, which is what makes this testable at all
// — and what makes NEXT_PUBLIC_APP_LOCALE a deploy-time switch rather
// than a per-request one.
//
// The mock below is not a stand-in for behaviour: `next-intl/server`
// resolves to its react-client build outside an RSC graph, and that build
// throws "`getRequestConfig` is not supported in Client Components" on
// import. The react-server build it stands in for is literally
// `createRequestConfig => createRequestConfig`.
vi.mock('next-intl/server', () => ({
  getRequestConfig: (createRequestConfig: unknown) => createRequestConfig,
}));

const params = { requestLocale: Promise.resolve(undefined) };
const original = process.env.NEXT_PUBLIC_APP_LOCALE;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_LOCALE;
  else process.env.NEXT_PUBLIC_APP_LOCALE = original;
});

describe('request config locale', () => {
  it('serves Spanish when NEXT_PUBLIC_APP_LOCALE is unset', async () => {
    delete process.env.NEXT_PUBLIC_APP_LOCALE;
    const config = await getConfig(params);
    expect(DEFAULT_LOCALE).toBe('es');
    expect(config.locale).toBe('es');
    expect(
      (config.messages as { Sidebar: { inbox: string } }).Sidebar.inbox
    ).toBe('Bandeja');
  });

  it('still serves en when the variable asks for it', async () => {
    process.env.NEXT_PUBLIC_APP_LOCALE = 'en';
    const config = await getConfig(params);
    expect(config.locale).toBe('en');
    expect(
      (config.messages as { Sidebar: { inbox: string } }).Sidebar.inbox
    ).toBe('Inbox');
  });

  it('ships exactly es and en', () => {
    expect([...LOCALES]).toEqual(['es', 'en']);
  });

  // s9.9: Korean was retired. A deployment still built with
  // NEXT_PUBLIC_APP_LOCALE=ko must land on Spanish, not on a missing
  // catalogue.
  it.each(['ko', 'xx', ''])(
    '%j is not a valid locale and resolves to es',
    async (locale) => {
      expect(resolveLocale(locale)).toBe('es');
      process.env.NEXT_PUBLIC_APP_LOCALE = locale;
      const config = await getConfig(params);
      expect(config.locale).toBe('es');
      expect(
        (config.messages as { Sidebar: { inbox: string } }).Sidebar.inbox
      ).toBe('Bandeja');
    }
  );
});
