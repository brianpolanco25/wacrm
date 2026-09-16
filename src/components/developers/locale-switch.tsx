import { Languages } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import {
  DOCS_LOCALES,
  type DocSlug,
  type DocsLocale,
} from '@/content/developers/types';
import { docHref } from '@/content/developers/nav';
import { cn } from '@/lib/utils';

/**
 * Nombres de idioma en su propio idioma. No son cadenas traducibles:
 * un selector que enseña "Spanish" a quien busca español no sirve de
 * nada, y por eso son constantes y no claves de catálogo.
 */
const ENDONYMS: Record<DocsLocale, string> = {
  es: 'Español',
  en: 'English',
};

/**
 * Selector de idioma de la prosa. Son dos enlaces a la MISMA página con
 * otro `?lang=`: sin estado, sin JavaScript y con el idioma elegido
 * visible en la URL que el visitante comparte.
 */
export function LocaleSwitch({
  locale,
  current,
}: {
  locale: DocsLocale;
  current: DocSlug;
}) {
  const t = useTranslations('Developers.ui');
  return (
    <div
      className="border-border bg-card flex items-center gap-0.5 rounded-lg border p-0.5"
      role="group"
      aria-label={t('language')}
    >
      <Languages
        className="text-muted-foreground ml-1.5 size-3.5"
        aria-hidden="true"
      />
      {DOCS_LOCALES.map((candidate) => (
        <Link
          key={candidate}
          href={docHref(current, candidate)}
          hrefLang={candidate}
          aria-current={candidate === locale ? 'true' : undefined}
          className={cn(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            candidate === locale
              ? 'bg-primary-soft text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {ENDONYMS[candidate]}
        </Link>
      ))}
    </div>
  );
}
