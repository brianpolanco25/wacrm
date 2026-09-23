import type { Metadata } from 'next';
import Link from 'next/link';

import { CabbityMark } from '@/components/auth/cabbity-logo';
import { DOCS_LOCALES, type DocsLocale } from '@/content/developers/types';
import { resolveDocsLocale } from '@/content/developers/nav';
import {
  getLegalDoc,
  LEGAL_ENTITY,
  LEGAL_SLUGS,
  type LegalSlug,
} from '@/content/legal';

// ============================================================
// Páginas legales públicas: `/privacy`, `/terms`, `/data-deletion`.
// Son las URL que piden Meta (para publicar la app y para la revisión)
// y PayPal. Se ven sin sesión y en el idioma de `?lang=` (es | en), con
// el mismo criterio que `/developers`.
// ============================================================

export interface LegalPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

const LINK_LABELS: Record<DocsLocale, Record<LegalSlug, string>> = {
  es: {
    privacy: 'Privacidad',
    terms: 'Términos',
    'data-deletion': 'Eliminación de datos',
  },
  en: { privacy: 'Privacy', terms: 'Terms', 'data-deletion': 'Data deletion' },
};

const UPDATED: Record<DocsLocale, string> = {
  es: 'Última actualización',
  en: 'Last updated',
};

async function readLocale(props: LegalPageProps): Promise<DocsLocale> {
  const { lang } = await props.searchParams;
  return resolveDocsLocale(lang);
}

export async function legalMetadata(
  slug: LegalSlug,
  props: LegalPageProps
): Promise<Metadata> {
  const doc = getLegalDoc(await readLocale(props), slug);
  return {
    title: doc.title,
    description: doc.summary,
    robots: { index: true, follow: true },
  };
}

export async function LegalPage({
  slug,
  ...props
}: LegalPageProps & { slug: LegalSlug }) {
  const locale = await readLocale(props);
  const doc = getLegalDoc(locale, slug);

  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border border-b">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          {/* La marca, no el lockup completo: el wordmark de CabbityLogo
              es navy fijo y en tema oscuro no se lee. */}
          <Link href="/" className="flex items-center gap-2">
            <CabbityMark className="text-brand size-8" />
            <span className="font-heading text-xl font-extrabold tracking-tight">
              {LEGAL_ENTITY.brand}
            </span>
          </Link>
          <nav className="flex gap-3 text-sm">
            {DOCS_LOCALES.map((l) => (
              <Link
                key={l}
                href={`/${slug}?lang=${l}`}
                aria-current={l === locale ? 'true' : undefined}
                className={
                  l === locale
                    ? 'font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }
              >
                {l.toUpperCase()}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="font-heading text-3xl font-extrabold tracking-tight">
          {doc.title}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {UPDATED[locale]}: {LEGAL_ENTITY.updatedAt}
        </p>

        {doc.sections.map((section) => (
          <section key={section.heading} className="mt-8">
            <h2 className="text-xl font-bold">{section.heading}</h2>
            {section.paragraphs?.map((p) => (
              <p key={p} className="mt-3 leading-relaxed">
                {p}
              </p>
            ))}
            {section.bullets && (
              <ul className="mt-3 list-disc space-y-1.5 pl-6 leading-relaxed">
                {section.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </main>

      <footer className="border-border border-t">
        <div className="text-muted-foreground mx-auto flex max-w-3xl flex-wrap gap-x-5 gap-y-2 px-4 py-6 text-sm">
          {LEGAL_SLUGS.map((s) => (
            <Link
              key={s}
              href={`/${s}?lang=${locale}`}
              className="hover:text-foreground"
            >
              {LINK_LABELS[locale][s]}
            </Link>
          ))}
          <span>
            © {LEGAL_ENTITY.legalName} · RNC {LEGAL_ENTITY.rnc} ·{' '}
            {LEGAL_ENTITY.email}
          </span>
        </div>
      </footer>
    </div>
  );
}
