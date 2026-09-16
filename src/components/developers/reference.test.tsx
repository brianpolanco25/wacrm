import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import es from '../../../messages/es.json';

import { OPENAPI_FIXTURE } from './openapi/fixture';
import { buildReference } from './openapi/model';
import { ReferenceView, referenceToc } from './openapi/render';
import { getOpenApiDocument } from './openapi/source';

// No hay jsdom ni testing-library en este repo (vitest corre en `node`),
// así que la referencia se renderiza a HTML estático. Es suficiente para
// lo que esta página tiene que garantizar: que ninguna operación del
// contrato se queda sin pintar.

const MODEL = buildReference(OPENAPI_FIXTURE);

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="es" timeZone="UTC" messages={es}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('ReferenceView', () => {
  const html = render(<ReferenceView model={MODEL} />);

  it('pinta TODAS las operaciones del documento', () => {
    const missing = MODEL.operations.filter(
      (operation) => !html.includes(`id="${operation.id}"`)
    );
    expect(missing.map((operation) => operation.id)).toEqual([]);
    expect(MODEL.operations.length).toBeGreaterThan(0);
  });

  it('enseña método y ruta de cada una', () => {
    for (const operation of MODEL.operations) {
      expect(html).toContain(operation.path);
      expect(html).toContain(`>${operation.method}<`);
    }
  });

  it('enseña el scope de cada operación, o que no pide ninguno', () => {
    expect(html).toContain('messages:send');
    expect(html).toContain('conversations:export');
    // `GET /api/v1/me` es la única sin scope.
    expect(html).toContain(es.Developers.reference.noScope);
  });

  it('marca las escrituras idempotentes', () => {
    expect(html).toContain(es.Developers.reference.idempotent);
  });

  it('incluye las secciones del documento y sus anclas', () => {
    for (const section of MODEL.sections) {
      expect(html).toContain(`id="${section.id}"`);
      expect(html).toContain(section.name);
    }
  });

  it('incluye los eventos de webhook con su ejemplo', () => {
    expect(html).toContain('id="webhook-events"');
    for (const webhook of MODEL.webhooks) {
      expect(html).toContain(webhook.event);
    }
  });

  it('pinta el curl de ejemplo y el botón de copiar', () => {
    expect(html).toContain('Authorization: Bearer $CABBITY_API_KEY');
    expect(html).toContain(es.Developers.ui.copy);
  });

  it('nombra el servidor base y la versión del contrato', () => {
    expect(html).toContain('https://tu-dominio.example.com');
    expect(html).toContain('1.2.0');
  });
});

describe('referenceToc', () => {
  it('lista una entrada por sección y otra para los webhooks', () => {
    const toc = referenceToc(MODEL, 'Eventos');
    expect(toc.map((entry) => entry.id)).toEqual([
      ...MODEL.sections.map((section) => section.id),
      'webhook-events',
    ]);
  });
});

describe('source', () => {
  it('sirve un documento OpenAPI 3.1 con rutas', () => {
    const doc = getOpenApiDocument();
    expect(doc.openapi.startsWith('3.1')).toBe(true);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });
});
