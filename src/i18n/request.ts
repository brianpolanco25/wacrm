import { getRequestConfig } from 'next-intl/server';

/**
 * Locale used when NEXT_PUBLIC_APP_LOCALE is unset. Spanish is the
 * product's default language; `en` and `ko` stay available by setting
 * the variable (see docs/docker.md). English remains the source of
 * truth for the catalogues, hence the fallback below.
 */
export const DEFAULT_LOCALE = 'es';

export default getRequestConfig(async () => {
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || DEFAULT_LOCALE;

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch (error) {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages,
  };
});
