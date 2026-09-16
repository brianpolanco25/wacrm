import { useTranslations } from 'next-intl';

import { API_RELEASES } from '@/content/developers/changelog';
import type { ApiRelease, DocsLocale } from '@/content/developers/types';

import { type TocEntry } from './docs-shell';
import { Inline } from './inline';

// El changelog se alimenta de un archivo de contenido por versión
// (`src/content/developers/changelog/`), así que publicar una versión no
// toca este componente.

const KIND_STYLES: Record<ApiRelease['changes'][number]['kind'], string> = {
  added: 'bg-positive/15 text-positive',
  changed: 'bg-primary-soft-2 text-foreground',
  fixed: 'bg-brand/15 text-brand-ink',
  deprecated: 'bg-muted text-muted-foreground',
};

/** Ancla estable de una versión: `v1.2` → `v1-2`. */
export function releaseAnchor(version: string): string {
  return version.replace(/\./g, '-');
}

export function changelogToc(): TocEntry[] {
  return API_RELEASES.map((release) => ({
    id: releaseAnchor(release.version),
    text: `${release.version} · ${release.date}`,
  }));
}

export function ChangelogView({ locale }: { locale: DocsLocale }) {
  const t = useTranslations('Developers.changelog');
  return (
    <div className="mt-10 space-y-10">
      {API_RELEASES.map((release) => (
        <section
          key={release.version}
          id={releaseAnchor(release.version)}
          className="scroll-mt-24"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-foreground text-xl font-semibold tracking-tight">
              {release.version}
            </h2>
            <time
              dateTime={release.date}
              className="text-muted-foreground font-mono text-sm"
            >
              {release.date}
            </time>
          </div>
          <p className="text-muted-foreground mt-2 leading-relaxed">
            {release.summary[locale]}
          </p>
          <ul className="border-border mt-4 space-y-3 border-l pl-5">
            {release.changes.map((change, i) => (
              <li key={i} className="text-muted-foreground leading-relaxed">
                <span
                  className={`mr-2 inline-block rounded-full px-2 py-0.5 align-[0.08em] text-[0.7rem] font-semibold ${KIND_STYLES[change.kind]}`}
                >
                  {t(change.kind)}
                </span>
                <Inline text={change.text[locale]} locale={locale} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
