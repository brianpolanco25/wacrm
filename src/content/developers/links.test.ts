import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { inlineLinks } from '@/components/developers/inline';

import { API_RELEASES } from './changelog';
import { getDocCatalogue, getDocSections } from './index';
import { DOC_NAV, DOC_SLUGS, docPath } from './nav';
import { DOCS_LOCALES, type DocBlock, type DocSlug } from './types';

// ============================================================
// Un enlace roto en la documentación pública es una promesa rota, y es
// el defecto más fácil de introducir: basta renombrar una carpeta de
// `src/app` o traducir una página y olvidar la otra. Este test recorre
// los dos idiomas enteros, saca cada enlace interno y lo compara con las
// rutas que existen DE VERDAD en el árbol de la aplicación.
// ============================================================

const APP_DIR = join(process.cwd(), 'src', 'app');

/**
 * Todas las URL que sirve el proyecto, leídas de `src/app/**`.
 *
 * Páginas (`page.tsx`) **y** manejadores de ruta (`route.ts`): la
 * documentación enlaza `GET /api/v1/openapi.json`, que es una URL de
 * verdad aunque no sea una página. Un segmento dinámico (`[id]`) entra
 * con los corchetes puestos, así que nunca casará con un enlace escrito
 * a mano — que es justo lo que se quiere.
 */
function appRoutes(): Set<string> {
  const routes = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const isPage = entry === 'page.tsx' || entry === 'page.ts';
      const isHandler = entry === 'route.ts' || entry === 'route.tsx';
      if (!isPage && !isHandler) continue;
      const segments = relative(APP_DIR, dir)
        .split(sep)
        .filter((segment) => segment !== '' && !segment.startsWith('('));
      routes.add(`/${segments.join('/')}`.replace(/\/$/, '') || '/');
    }
  };
  walk(APP_DIR);
  return routes;
}

/** Los `href` que aparecen dentro de un bloque de contenido. */
function blockLinks(block: DocBlock): string[] {
  switch (block.kind) {
    case 'lead':
    case 'p':
    case 'note':
      return inlineLinks(block.text);
    case 'ul':
    case 'ol':
      return block.items.flatMap(inlineLinks);
    case 'table':
      return block.rows.flat().flatMap(inlineLinks);
    case 'cards':
      return block.items.map((item) => item.href);
    default:
      return [];
  }
}

interface FoundLink {
  href: string;
  where: string;
}

function allLinks(): FoundLink[] {
  const found: FoundLink[] = [];
  for (const locale of DOCS_LOCALES) {
    const catalogue = getDocCatalogue(locale);
    for (const slug of DOC_SLUGS) {
      for (const href of catalogue[slug].blocks.flatMap(blockLinks)) {
        found.push({ href, where: `${locale}:${slug}` });
      }
    }
    for (const release of API_RELEASES) {
      for (const change of release.changes) {
        for (const href of inlineLinks(change.text[locale])) {
          found.push({ href, where: `${locale}:changelog:${release.version}` });
        }
      }
    }
  }
  // El propio menú: si una entrada apunta a una ruta que no existe, la
  // sección se rompe sola.
  for (const slug of DOC_SLUGS) {
    found.push({ href: docPath(slug), where: 'nav' });
  }
  return found;
}

describe('enlaces internos de /developers', () => {
  const routes = appRoutes();

  it('el árbol de la aplicación trae las rutas de la sección', () => {
    // Guarda del propio test: si el escáner dejara de encontrar páginas,
    // todo lo de abajo pasaría por vacío.
    expect(routes.has('/developers')).toBe(true);
    expect(routes.has('/developers/reference')).toBe(true);
    // El contrato legible por máquinas, que la prosa enlaza.
    expect(routes.has('/api/v1/openapi.json')).toBe(true);
    expect(routes.size).toBeGreaterThan(20);
  });

  it('ningún enlace interno apunta a una ruta que no existe', () => {
    const broken = allLinks()
      .filter(({ href }) => href.startsWith('/'))
      .filter(({ href }) => !routes.has(href.split(/[?#]/)[0]))
      .map(({ href, where }) => `${where} → ${href}`);
    expect(broken).toEqual([]);
  });

  it('los enlaces externos son https', () => {
    const insecure = allLinks()
      .filter(({ href }) => !href.startsWith('/'))
      .filter(({ href }) => !href.startsWith('https://'))
      .map(({ href, where }) => `${where} → ${href}`);
    expect(insecure).toEqual([]);
  });
});

describe('enlaces del panel hacia la documentación', () => {
  // Ajustes → API y Ajustes → Webhooks enlazan aquí. El día que una
  // página se renombre, esto falla antes de que el cliente encuentre un
  // 404 desde el panel.
  const PANELS = [
    'src/components/settings/api-keys-settings.tsx',
    'src/components/settings/webhooks-settings.tsx',
  ];

  it.each(PANELS)('%s apunta a una página que existe', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const hrefs = [...source.matchAll(/'(\/developers[^']*)'/g)].map(
      (m) => m[1]
    );
    expect(
      hrefs.length,
      `${file} ya no enlaza la documentación`
    ).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(appRoutes().has(href.split(/[?#]/)[0]), `${file} → ${href}`).toBe(
        true
      );
    }
  });
});

describe('catálogos de prosa', () => {
  it.each(DOCS_LOCALES)(
    '%s tiene una página por entrada del menú',
    (locale) => {
      const catalogue = getDocCatalogue(locale);
      for (const slug of DOC_SLUGS) {
        expect(catalogue[slug], `falta ${slug} en ${locale}`).toBeTruthy();
        expect(catalogue[slug].slug).toBe(slug);
        expect(catalogue[slug].title.length).toBeGreaterThan(0);
        expect(catalogue[slug].summary.length).toBeGreaterThan(0);
        expect(catalogue[slug].blocks.length).toBeGreaterThan(0);
      }
    }
  );

  it.each(DOCS_LOCALES)('%s nombra los tres grupos del menú', (locale) => {
    const labels = getDocSections(locale);
    for (const group of DOC_NAV) {
      expect(labels[group.id].length).toBeGreaterThan(0);
    }
  });

  it('el menú no repite ni se deja ningún slug', () => {
    expect(new Set(DOC_SLUGS).size).toBe(DOC_SLUGS.length);
    const inCatalogue = Object.keys(getDocCatalogue('es')) as DocSlug[];
    expect([...DOC_SLUGS].sort()).toEqual([...inCatalogue].sort());
  });

  it.each(DOCS_LOCALES)('%s no repite el id de un encabezado', (locale) => {
    const catalogue = getDocCatalogue(locale);
    for (const slug of DOC_SLUGS) {
      const ids = catalogue[slug].blocks
        .filter((block) => block.kind === 'h2' || block.kind === 'h3')
        .map((block) => (block as { id: string }).id);
      expect(new Set(ids).size, `ids repetidos en ${locale}:${slug}`).toBe(
        ids.length
      );
    }
  });

  it('el changelog va de lo más reciente a lo más antiguo', () => {
    const dates = API_RELEASES.map((release) => release.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(API_RELEASES.length).toBeGreaterThan(0);
  });

  it.each(DOCS_LOCALES)('%s traduce cada línea del changelog', (locale) => {
    for (const release of API_RELEASES) {
      expect(release.summary[locale]?.length ?? 0).toBeGreaterThan(0);
      for (const change of release.changes) {
        expect(change.text[locale]?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
