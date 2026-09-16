import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import { getDocCatalogue } from '@/content/developers';
import { DOC_SLUGS } from '@/content/developers/nav';

import { DocArticle } from './doc-article';
import { DocsShell, tocFromBlocks } from './docs-shell';

type Catalogue = typeof es;

function render(node: React.ReactElement, messages: Catalogue = es) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="es" timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('DocsShell', () => {
  it('lista todas las páginas del menú, con los títulos del idioma leído', () => {
    const html = render(
      <DocsShell locale="es" current="start">
        <p>contenido</p>
      </DocsShell>
    );
    const catalogue = getDocCatalogue('es');
    for (const slug of DOC_SLUGS) {
      expect(html).toContain(catalogue[slug].title);
    }
  });

  it('cambia la prosa del menú al elegir inglés, sin cambiar la interfaz', () => {
    const html = render(
      <DocsShell locale="en" current="start">
        <p>contenido</p>
      </DocsShell>
    );
    // Prosa en inglés…
    expect(html).toContain(getDocCatalogue('en').conventions.title);
    // …e interfaz en el idioma de la instancia, que aquí es español.
    expect(html).toContain(es.Developers.ui.menu);
    expect(html).toContain(es.Developers.ui.skipToContent);
  });

  it('marca la página actual para los lectores de pantalla', () => {
    const html = render(
      <DocsShell locale="es" current="reference">
        <p>contenido</p>
      </DocsShell>
    );
    expect(html).toContain('aria-current="page"');
  });

  it('ofrece los dos idiomas en el selector, sobre la misma página', () => {
    const html = render(
      <DocsShell locale="es" current="guides/exports">
        <p>contenido</p>
      </DocsShell>
    );
    expect(html).toContain('href="/developers/guides/exports"');
    expect(html).toContain('href="/developers/guides/exports?lang=en"');
  });

  it('pinta el índice de la página cuando hay encabezados', () => {
    const page = getDocCatalogue('es').conventions;
    const html = render(
      <DocsShell
        locale="es"
        current="conventions"
        toc={tocFromBlocks(page.blocks)}
      >
        <p>contenido</p>
      </DocsShell>
    );
    expect(html).toContain(es.Developers.ui.onThisPage);
    expect(html).toContain('href="#idempotencia"');
  });

  it('usa la interfaz en inglés cuando la instancia está en inglés', () => {
    const html = render(
      <DocsShell locale="en" current="start">
        <p>contenido</p>
      </DocsShell>,
      en as Catalogue
    );
    expect(html).toContain(en.Developers.ui.skipToContent);
  });

  it('declara el idioma de la prosa en el contenido y en el menú', () => {
    // Instancia en español (`messages = es`) leyendo la prosa en inglés:
    // el `<html lang>` del layout raíz dice "es" y el texto está en
    // inglés, así que los contenedores de prosa tienen que corregirlo.
    const html = render(
      <DocsShell locale="en" current="start">
        <p>contenido</p>
      </DocsShell>
    );
    expect(html).toContain('<main id="docs-content" lang="en"');
    // Menú lateral y desplegable de móvil: sus entradas son títulos de
    // página, o sea prosa, y repiten el mismo `NavList`.
    // El espacio delante evita contar los `hreflang=` del selector.
    expect(html.match(/ lang="en"/g) ?? []).toHaveLength(3);
    expect(html).not.toContain(' lang="es"');
  });

  it('declara español cuando la prosa se lee en español', () => {
    const html = render(
      <DocsShell locale="es" current="start">
        <p>contenido</p>
      </DocsShell>
    );
    expect(html).toContain('<main id="docs-content" lang="es"');
    expect(html.match(/ lang="es"/g) ?? []).toHaveLength(3);
  });
});

describe('DocArticle', () => {
  const page = getDocCatalogue('es').conventions;
  const html = render(<DocArticle page={page} locale="es" />);

  it('pone el título de la página en un h1', () => {
    expect(html).toContain(`<h1 class=`);
    expect(html).toContain(page.title);
  });

  it('da id a cada encabezado, para poder enlazarlo', () => {
    for (const entry of tocFromBlocks(page.blocks)) {
      expect(html).toContain(`id="${entry.id}"`);
    }
  });

  it('pinta tablas, avisos y bloques de código', () => {
    expect(html).toContain('<table');
    expect(html).toContain('<aside');
    expect(html).toContain(es.Developers.ui.copy);
  });
});
