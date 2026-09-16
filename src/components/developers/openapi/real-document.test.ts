import { afterEach, describe, expect, it, vi } from 'vitest';

import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';

import { OPENAPI_FIXTURE } from './fixture';
import { buildReference, serverBasePath } from './model';
import { docsServerOrigin, getOpenApiDocument } from './source';
import { HTTP_METHODS, type OpenApiDocument } from './types';

// ============================================================
// La referencia contra el documento DE VERDAD.
//
// `model.test.ts` prueba el renderizador contra un documento cualquiera
// (el fixture). Esto prueba lo otro: que lo que `/developers/reference`
// pinta es el contrato que sirve `GET /api/v1/openapi.json`, y que el
// fixture no se ha quedado atrás.
//
// La regla de composición de la fase (ver `resolveServerUrl` en
// `src/lib/api/v1/openapi/document.ts`):
//
//   URL de una operación = `servers[0].url` + clave de `paths`
//
// donde el servidor lleva el prefijo `/api/v1` y la clave no. El error
// que este archivo existe para cazar es el prefijo duplicado o ausente
// en los `curl` que el cliente copia y pega.
// ============================================================

/** Método + ruta completa + scopes, de un documento cualquiera. */
function inventory(doc: OpenApiDocument): string[] {
  const base = serverBasePath(doc.servers?.[0]?.url);
  const rows: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const scopes = [...(operation['x-scopes'] ?? [])].sort().join(',');
      rows.push(`${method.toUpperCase()} ${base}${path} [${scopes}]`);
    }
  }
  return rows.sort();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('el documento que pinta la referencia', () => {
  const doc = getOpenApiDocument();
  const model = buildReference(doc);

  it('sale del generador real, no del fixture', () => {
    // El generador declara su versión en `info.version` y sus 25 rutas
    // se leen del árbol de `src/app/api/v1` (`coverage.test.ts`).
    expect(Object.keys(doc.paths)).toHaveLength(25);
    expect(model.operations).toHaveLength(37);
  });

  it('ninguna clave de `paths` trae el prefijo', () => {
    const conPrefijo = Object.keys(doc.paths).filter((path) =>
      path.startsWith('/api/v1')
    );
    expect(conPrefijo).toEqual([]);
  });

  it('el servidor termina en exactamente un /api/v1', () => {
    expect(model.server).toBe(`${docsServerOrigin()}/api/v1`);
  });

  it('enseña la ruta completa de cada operación', () => {
    const mal = model.operations
      .map((op) => op.path)
      .filter((path) => !path.startsWith('/api/v1/'));
    expect(mal).toEqual([]);
  });

  it('el curl de cada operación es absoluto y con un solo /api/v1', () => {
    for (const op of model.operations) {
      const url = op.curl.match(/curl (?:-X [A-Z]+ )?"([^"]+)"/)?.[1];
      expect(url, `curl de ${op.method} ${op.path}`).toBeDefined();
      expect(url!.startsWith('https://'), `${url} no es absoluta`).toBe(true);
      expect(
        url!.match(/\/api\/v1/g) ?? [],
        `${url} repite el prefijo`
      ).toHaveLength(1);
      // La URL del curl es el origen + la ruta que se enseña arriba.
      expect(url).toBe(`${docsServerOrigin()}${op.path}`);
    }
  });

  it('las anclas conservan la ruta completa', () => {
    const me = model.operations.find((op) => op.path === '/api/v1/me');
    expect(me?.id).toBe('get-api-v1-me');
    expect(new Set(model.operations.map((op) => op.id)).size).toBe(
      model.operations.length
    );
  });

  it('describe los once eventos de `WEBHOOK_EVENTS`, en su orden', () => {
    expect(model.webhooks.map((hook) => hook.event)).toEqual([
      ...WEBHOOK_EVENTS,
    ]);
  });
});

describe('el origen de los ejemplos', () => {
  it('usa el dominio canónico de la instancia cuando está configurado', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com/');
    expect(docsServerOrigin()).toBe('https://crm.example.com');
    const model = buildReference(getOpenApiDocument());
    expect(model.server).toBe('https://crm.example.com/api/v1');
    expect(model.operations[0].curl).toContain(
      'https://crm.example.com/api/v1'
    );
  });

  it('sin variable cae a un dominio de ejemplo, nunca a una URL relativa', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(docsServerOrigin()).toBe('https://tu-dominio.example.com');
  });
});

describe('el fixture no se separa del documento real', () => {
  // El fixture es el documento con el que se prueba el renderizador. Si
  // deriva del real, los tests de `model.test.ts` pasarían a afirmar
  // cosas de una API que no existe.
  it('cubre las mismas 37 operaciones, con la misma ruta y los mismos scopes', () => {
    const real = inventory(getOpenApiDocument());
    expect(real).toHaveLength(37);
    expect(inventory(OPENAPI_FIXTURE)).toEqual(real);
  });

  it('cubre los mismos eventos, en el mismo orden', () => {
    expect(Object.keys(OPENAPI_FIXTURE.webhooks ?? {})).toEqual(
      Object.keys(getOpenApiDocument().webhooks ?? {})
    );
    expect(Object.keys(OPENAPI_FIXTURE.webhooks ?? {})).toHaveLength(
      WEBHOOK_EVENTS.length
    );
  });

  it('comparte la forma: servidor con prefijo, claves sin prefijo', () => {
    expect(serverBasePath(OPENAPI_FIXTURE.servers?.[0]?.url)).toBe('/api/v1');
    expect(
      Object.keys(OPENAPI_FIXTURE.paths).filter((path) =>
        path.startsWith('/api/v1')
      )
    ).toEqual([]);
  });
});
