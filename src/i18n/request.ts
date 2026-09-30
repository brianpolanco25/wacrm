import { getRequestConfig } from 'next-intl/server';

/**
 * Locale used when NEXT_PUBLIC_APP_LOCALE is unset — or set to anything
 * the product does not ship. Spanish is the product's default language;
 * `en` stays available by setting the variable (see docs/docker.md).
 */
export const DEFAULT_LOCALE = 'es';

/** The locales with a catalogue in `messages/`. Nothing else is served. */
export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Maps a requested locale onto one the product ships. Anything outside
 * `LOCALES` — including `ko`, retired in s9.9 — resolves to the default,
 * so a stale NEXT_PUBLIC_APP_LOCALE never renders raw keypaths.
 */
export function resolveLocale(value: string | undefined | null): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = resolveLocale(process.env.NEXT_PUBLIC_APP_LOCALE);
  const messages = (await import(`../../messages/${locale}.json`)).default;

  return {
    locale,
    messages,
  };
});
