import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Inline, inlineLinks, parseInline } from './inline';

// El marcado en línea es un parser propio (S-A3: sin markdown), así que
// se prueba solo, sin pasar por ninguna página.

describe('parseInline', () => {
  it('deja el texto llano en un solo nodo', () => {
    expect(parseInline('sin marcas')).toEqual([
      { type: 'text', value: 'sin marcas' },
    ]);
  });

  it('reconoce código, negrita y enlaces', () => {
    expect(
      parseInline('usa `curl` con **cuidado** y lee [esto](/developers)')
    ).toEqual([
      { type: 'text', value: 'usa ' },
      { type: 'code', value: 'curl' },
      { type: 'text', value: ' con ' },
      { type: 'strong', value: 'cuidado' },
      { type: 'text', value: ' y lee ' },
      { type: 'link', value: 'esto', href: '/developers' },
    ]);
  });

  it('no interpreta marcas dentro de un tramo de código', () => {
    expect(parseInline('`a **b** c`')).toEqual([
      { type: 'code', value: 'a **b** c' },
    ]);
  });

  it('deja en paz un asterisco suelto o un corchete sin enlace', () => {
    expect(parseInline('2 * 3 y [nada]')).toEqual([
      { type: 'text', value: '2 * 3 y [nada]' },
    ]);
  });

  it('saca los href de un texto', () => {
    expect(
      inlineLinks('[uno](/developers/guides) y [dos](https://example.com)')
    ).toEqual(['/developers/guides', 'https://example.com']);
  });
});

describe('Inline', () => {
  it('arrastra el idioma elegido a los enlaces internos de la sección', () => {
    const html = renderToStaticMarkup(
      <Inline text="ver [convenciones](/developers/conventions)" locale="en" />
    );
    expect(html).toContain('href="/developers/conventions?lang=en"');
  });

  it('no toca el enlace cuando se lee en el idioma de la instancia', () => {
    const html = renderToStaticMarkup(
      <Inline text="ver [convenciones](/developers/conventions)" locale="es" />
    );
    expect(html).toContain('href="/developers/conventions"');
  });

  it('abre los enlaces externos en otra pestaña, sin filtrar el referente', () => {
    const html = renderToStaticMarkup(
      <Inline text="[MCP](https://modelcontextprotocol.io)" locale="es" />
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('no arrastra el idioma a una ruta de fuera de la sección', () => {
    const html = renderToStaticMarkup(
      <Inline text="[ajustes](/settings)" locale="en" />
    );
    expect(html).toContain('href="/settings"');
  });
});
