import { resolveLocale } from '@/i18n/request';

import { DOCS_LOCALES, type DocSlug, type DocsLocale } from './types';

/** Raíz de la sección. Pública: el middleware no la protege. */
export const DOCS_BASE = '/developers';

/**
 * Idioma de la prosa cuando el visitante no ha elegido ninguno.
 *
 * La instancia tiene un solo idioma de interfaz (`NEXT_PUBLIC_APP_LOCALE`,
 * `src/i18n/request.ts`), así que se hereda: una instancia en español
 * abre la documentación en español. Un valor que el producto no sirve
 * (`ko`, retirado en s9.9, o cualquier otro) cae a `es` igual que la
 * interfaz, vía `resolveLocale`.
 */
export function instanceDocsLocale(): DocsLocale {
  return resolveLocale(process.env.NEXT_PUBLIC_APP_LOCALE);
}

/** Lee el `?lang=` de la URL; cualquier otra cosa es el idioma de la instancia. */
export function resolveDocsLocale(
  value: string | string[] | undefined
): DocsLocale {
  const first = Array.isArray(value) ? value[0] : value;
  return DOCS_LOCALES.includes(first as DocsLocale)
    ? (first as DocsLocale)
    : instanceDocsLocale();
}

/**
 * URL de una página. El idioma viaja en la query en vez de en el
 * segmento (`/developers/es/...`) para que la sección tenga UNA ruta por
 * página: el panel enlaza `/developers` sin saber en qué idioma está el
 * visitante, y el selector solo cambia el parámetro.
 *
 * Se omite cuando coincide con el idioma de la instancia, que es el caso
 * de casi todo el mundo: así las URL que se comparten quedan limpias.
 */
export function docHref(slug: DocSlug, locale: DocsLocale): string {
  const path = slug === 'start' ? DOCS_BASE : `${DOCS_BASE}/${slug}`;
  return locale === instanceDocsLocale() ? path : `${path}?lang=${locale}`;
}

/** Ruta sin idioma, que es la que existe en el árbol de `src/app`. */
export function docPath(slug: DocSlug): string {
  return slug === 'start' ? DOCS_BASE : `${DOCS_BASE}/${slug}`;
}

export interface DocNavGroup {
  /** Clave del título del grupo en el catálogo de prosa. */
  id: 'start' | 'guides' | 'reference';
  items: DocSlug[];
}

/** El menú lateral, en orden. Es la única fuente del orden de las páginas. */
export const DOC_NAV: DocNavGroup[] = [
  { id: 'start', items: ['start', 'authentication', 'conventions'] },
  {
    id: 'guides',
    items: [
      'guides',
      'guides/templates',
      'guides/contacts-tags',
      'guides/exports',
      'guides/webhooks',
    ],
  },
  {
    id: 'reference',
    items: ['reference', 'webhooks', 'integrations', 'changelog'],
  },
];

/** Todos los slugs, en el orden del menú. */
export const DOC_SLUGS: DocSlug[] = DOC_NAV.flatMap((group) => group.items);

/**
 * Añade el idioma elegido a un enlace interno de la sección. El
 * contenido se escribe con rutas limpias (`/developers/conventions`) y
 * es el renderizador el que arrastra el `?lang=`, para que la prosa no
 * tenga que saber en qué idioma se está leyendo a sí misma.
 */
export function withDocsLang(href: string, locale: DocsLocale): string {
  if (!href.startsWith(DOCS_BASE)) return href;
  if (href.includes('?')) return href;
  if (locale === instanceDocsLocale()) return href;
  const [path, hash] = href.split('#');
  return hash ? `${path}?lang=${locale}#${hash}` : `${path}?lang=${locale}`;
}
