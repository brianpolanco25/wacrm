import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { CabbityMark } from '@/components/auth/cabbity-logo';
import { getDocCatalogue, getDocSections } from '@/content/developers';
import { DOC_NAV, docHref } from '@/content/developers/nav';
import type { DocBlock, DocSlug, DocsLocale } from '@/content/developers/types';
import { cn } from '@/lib/utils';

import { LocaleSwitch } from './locale-switch';

// ============================================================
// Cascarón de /developers. Layout propio, sin nada del panel: esta
// sección se ve sin sesión (el middleware no la protege) y no puede
// depender de `useAuth`, de la barra lateral del dashboard ni de ningún
// dato de cuenta.
//
// El idioma de la PROSA lo elige el visitante (`?lang=`), mientras que
// los textos de interfaz —copiar, menú, "en esta página"— siguen el
// idioma de la instancia y salen de `messages/*.json` (CP6). Son dos
// dimensiones distintas a propósito: una instancia en coreano enseña su
// interfaz en coreano y la prosa en inglés, que es lo que dice S-A5.
// ============================================================

export interface TocEntry {
  id: string;
  text: string;
}

/** Los `h2` de una página, que es lo que se ofrece como índice lateral. */
export function tocFromBlocks(blocks: DocBlock[]): TocEntry[] {
  return blocks
    .filter(
      (block): block is Extract<DocBlock, { kind: 'h2' }> => block.kind === 'h2'
    )
    .map(({ id, text }) => ({ id, text }));
}

function NavList({
  locale,
  current,
}: {
  locale: DocsLocale;
  current: DocSlug;
}) {
  const catalogue = getDocCatalogue(locale);
  const sections = getDocSections(locale);
  return (
    <div className="space-y-6">
      {DOC_NAV.map((group) => (
        <div key={group.id}>
          <p className="text-muted-foreground px-3 text-[0.7rem] font-semibold tracking-[0.16em] uppercase">
            {sections[group.id]}
          </p>
          <ul className="mt-2 space-y-0.5">
            {group.items.map((slug) => {
              const active = slug === current;
              return (
                <li key={slug}>
                  <Link
                    href={docHref(slug, locale)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-lg px-3 py-1.5 text-sm transition-colors',
                      active
                        ? 'bg-primary-soft text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-card-2 hover:text-foreground'
                    )}
                  >
                    {catalogue[slug].title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function DocsShell({
  locale,
  current,
  toc,
  children,
}: {
  locale: DocsLocale;
  current: DocSlug;
  toc?: TocEntry[];
  children: React.ReactNode;
}) {
  const t = useTranslations('Developers.ui');
  const entries = toc ?? [];

  return (
    <div className="bg-background text-foreground min-h-screen">
      <a
        href="#docs-content"
        className="focus:bg-card focus:text-foreground sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:px-4 focus:py-2"
      >
        {t('skipToContent')}
      </a>

      <header className="border-border bg-background/90 sticky top-0 z-40 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link
            href={docHref('start', locale)}
            className="flex items-center gap-2.5 font-semibold"
          >
            <CabbityMark className="text-brand size-7" />
            <span className="text-foreground">Cabbity CRM</span>
            <span className="text-muted-foreground border-border hidden border-l pl-2.5 text-sm font-normal sm:inline">
              {t('apiDocs')}
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <LocaleSwitch locale={locale} current={current} />
            <Link
              href="/settings"
              className="text-muted-foreground hover:text-foreground hidden items-center gap-1.5 text-sm sm:inline-flex"
            >
              {t('dashboard')}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-8 px-4 sm:px-6">
        <nav
          aria-label={t('nav')}
          className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 overflow-y-auto py-8 lg:block"
        >
          <NavList locale={locale} current={current} />
        </nav>

        <div className="min-w-0 flex-1 py-8">
          <details className="border-border bg-card mb-6 rounded-xl border lg:hidden">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              {t('menu')}
            </summary>
            <div className="px-2 pt-1 pb-4">
              <NavList locale={locale} current={current} />
            </div>
          </details>

          <main id="docs-content" className="min-w-0">
            {children}
          </main>

          <footer className="border-border text-muted-foreground mt-16 border-t py-8 text-sm">
            {t('footer')}
          </footer>
        </div>

        {entries.length > 0 && (
          <nav
            aria-label={t('onThisPage')}
            className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 overflow-y-auto py-8 xl:block"
          >
            <p className="text-muted-foreground text-[0.7rem] font-semibold tracking-[0.16em] uppercase">
              {t('onThisPage')}
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={`#${entry.id}`}
                    className="text-muted-foreground hover:text-foreground block leading-snug"
                  >
                    {entry.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </div>
  );
}
