// ============================================================
// Modelo de contenido de la documentación pública (/developers).
//
// S-A5 de `progress/spec_api-publica.md`: la prosa larga vive en
// archivos de contenido por idioma, NO en `messages/*.json`. Los
// catálogos guardan solo los textos de interfaz (botones, selector,
// etiquetas de navegación auxiliares), que siguen el idioma de la
// instancia; la prosa sigue el idioma que elige el visitante con el
// selector, y son dos cosas distintas a propósito.
//
// El contenido es un array de bloques tipados en vez de markdown o MDX
// porque S-A3 prohíbe dependencias nuevas: sin parser de markdown, sin
// resaltador. Lo que se gana a cambio es que un test puede recorrer los
// bloques —para comprobar, por ejemplo, que ningún enlace interno está
// roto— sin analizar cadenas.
// ============================================================

/** Idiomas en los que existe la prosa. El coreano cae a inglés. */
export const DOCS_LOCALES = ['es', 'en'] as const;
export type DocsLocale = (typeof DOCS_LOCALES)[number];

/**
 * Texto con marcado en línea mínimo, interpretado por
 * `src/components/developers/inline.tsx`:
 *
 *   `código`            → <code>
 *   **fuerte**          → <strong>
 *   [texto](/ruta)      → enlace (interno con next/link, externo con <a>)
 *
 * Es deliberadamente pobre: tres marcas que cubren el 100 % de la prosa
 * técnica de esta sección y se parsean en veinte líneas.
 */
export type InlineText = string;

export type DocBlock =
  /** Párrafo de entrada, un punto más grande que el resto. */
  | { kind: 'lead'; text: InlineText }
  | { kind: 'p'; text: InlineText }
  | { kind: 'h2'; id: string; text: string }
  | { kind: 'h3'; id: string; text: string }
  | { kind: 'ul'; items: InlineText[] }
  | { kind: 'ol'; items: InlineText[] }
  | { kind: 'table'; head: string[]; rows: InlineText[][] }
  | { kind: 'note'; tone: 'info' | 'warn' | 'good'; text: InlineText }
  | { kind: 'code'; lang: string; label?: string; code: string }
  | { kind: 'cards'; items: { href: string; title: string; text: string }[] };

/** Identificadores de página. El orden no importa; el de la navegación sí. */
export type DocSlug =
  | 'start'
  | 'authentication'
  | 'conventions'
  | 'guides'
  | 'guides/templates'
  | 'guides/contacts-tags'
  | 'guides/exports'
  | 'guides/webhooks'
  | 'reference'
  | 'webhooks'
  | 'integrations'
  | 'changelog';

export interface DocPage {
  slug: DocSlug;
  /** Título de la página y, a la vez, su etiqueta en la navegación. */
  title: string;
  /** Una frase; va al `<meta name="description">` y a las tarjetas. */
  summary: string;
  blocks: DocBlock[];
}

/** Catálogo de prosa de un idioma: una entrada por slug, sin huecos. */
export type DocCatalogue = Record<DocSlug, DocPage>;

/** Grupos del menú lateral; los títulos son prosa, así que van por idioma. */
export interface DocSectionLabels {
  start: string;
  guides: string;
  reference: string;
}

/** Una versión publicada de la API. Un archivo de contenido por versión. */
export interface ApiRelease {
  /** Etiqueta visible de la versión (`v1.2`). */
  version: string;
  /** ISO-8601 corto (`2026-09-16`), para ordenar sin ambigüedad. */
  date: string;
  summary: Record<DocsLocale, string>;
  changes: {
    kind: 'added' | 'changed' | 'fixed' | 'deprecated';
    text: Record<DocsLocale, InlineText>;
  }[];
}
