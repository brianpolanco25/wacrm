import * as en from './en';
import * as es from './es';
import type {
  DocCatalogue,
  DocPage,
  DocSectionLabels,
  DocSlug,
  DocsLocale,
} from './types';

// Punto único de acceso a la prosa. Las páginas la piden por
// (idioma, slug) y no saben en qué archivo vive.

const CATALOGUES: Record<DocsLocale, DocCatalogue> = {
  es: es.catalogue,
  en: en.catalogue,
};

const SECTIONS: Record<DocsLocale, DocSectionLabels> = {
  es: es.sections,
  en: en.sections,
};

export function getDocCatalogue(locale: DocsLocale): DocCatalogue {
  return CATALOGUES[locale];
}

export function getDocPage(locale: DocsLocale, slug: DocSlug): DocPage {
  return CATALOGUES[locale][slug];
}

export function getDocSections(locale: DocsLocale): DocSectionLabels {
  return SECTIONS[locale];
}
