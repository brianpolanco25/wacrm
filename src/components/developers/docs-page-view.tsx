import type { Metadata } from 'next';

import { getDocPage } from '@/content/developers';
import {
  DOCS_LOCALES,
  type DocSlug,
  type DocsLocale,
} from '@/content/developers/types';
import { docPath, resolveDocsLocale } from '@/content/developers/nav';

import { DocArticle } from './doc-article';
import { DocsShell, tocFromBlocks, type TocEntry } from './docs-shell';

// ============================================================
// Puente entre las rutas de `src/app/(public)/developers/**` y el
// contenido. Cada `page.tsx` queda en cuatro líneas: elige su slug, lee
// el idioma de la query y delega aquí.
// ============================================================

/** Lo que Next entrega a un `page.tsx` de esta sección. */
export interface DocsPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/** El idioma de la prosa pedido en `?lang=`, o el de la instancia. */
export async function readDocsLocale(
  props: DocsPageProps
): Promise<DocsLocale> {
  const { lang } = await props.searchParams;
  return resolveDocsLocale(lang);
}

/**
 * Metadatos por página. A diferencia del resto de la aplicación —cuyo
 * layout raíz pide `noindex` porque es un panel privado—, esta sección
 * es pública y sí se indexa.
 */
export async function docsMetadata(
  slug: DocSlug,
  props: DocsPageProps
): Promise<Metadata> {
  const locale = await readDocsLocale(props);
  const page = getDocPage(locale, slug);
  return {
    title: page.title,
    description: page.summary,
    robots: { index: true, follow: true },
    alternates: {
      canonical: docPath(slug),
      languages: Object.fromEntries(
        DOCS_LOCALES.map((candidate) => [
          candidate,
          `${docPath(slug)}?lang=${candidate}`,
        ])
      ),
    },
  };
}

export function DocsPageView({
  slug,
  locale,
  extraToc,
  children,
}: {
  slug: DocSlug;
  locale: DocsLocale;
  /** Entradas de índice de la parte generada (referencia, changelog). */
  extraToc?: TocEntry[];
  children?: React.ReactNode;
}) {
  const page = getDocPage(locale, slug);
  return (
    <DocsShell
      locale={locale}
      current={slug}
      toc={[...tocFromBlocks(page.blocks), ...(extraToc ?? [])]}
    >
      <DocArticle page={page} locale={locale}>
        {children}
      </DocArticle>
    </DocsShell>
  );
}
