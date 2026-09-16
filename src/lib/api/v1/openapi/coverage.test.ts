// ============================================================
// Cobertura: el documento y el árbol de rutas dicen lo mismo.
//
// Recorre `src/app/api/v1/**/route.ts`, saca de cada archivo los
// métodos HTTP que EXPORTA y convierte la ruta del sistema de ficheros
// en una ruta OpenAPI (`[id]` → `{id}`), y compara en los DOS sentidos:
//
//   - una operación en el código que no está en el documento → falla;
//   - una operación en el documento que no existe en el código → falla.
//
// Es la guarda que pide el criterio de §6: una ruta nueva sin
// documentar rompe CI, y una operación documentada que alguien borró
// también. Se lee del disco a propósito —no de un registro paralelo—
// porque el disco es lo que despliega.
// ============================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { API_BASE_PATH, buildOpenApiDocument } from './document';
import { HTTP_METHODS, type HttpMethod } from './types';

const ROUTES_ROOT = join(process.cwd(), 'src', 'app', 'api', 'v1');

/**
 * `/api/v1`, pero sacado de DÓNDE viven las rutas en el árbol de
 * archivos, no de `API_BASE_PATH`: así la comprobación de composición
 * de abajo no se mide con su propia vara.
 */
const URL_PREFIX_FROM_DISK = `/${relative(
  join(process.cwd(), 'src', 'app'),
  ROUTES_ROOT
)
  .split(sep)
  .join('/')}`;

/**
 * La propia ruta del documento queda fuera: es la que SIRVE el
 * contrato, no una operación del contrato. Documentarse a sí misma no
 * añadiría nada y obligaría a modelar una respuesta que no es el sobre.
 */
const EXCLUDED_ROUTE_FILES = new Set(['openapi.json']);

interface DiscoveredOperation {
  method: HttpMethod;
  path: string;
  file: string;
}

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_ROUTE_FILES.has(entry)) continue;
      walkRouteFiles(full, out);
    } else if (entry === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

/**
 * `src/app/api/v1/contacts/[id]/tags/[tagId]/route.ts`
 *   → `/contacts/{id}/tags/{tagId}`
 *
 * **Sin** el prefijo `/api/v1`: las claves de `paths` del documento
 * son relativas a `servers[0].url`, que es quien lo lleva (ver
 * `resolveServerUrl` en `document.ts`).
 */
function routePathFromFile(file: string): string {
  const segments = relative(ROUTES_ROOT, file).split(sep);
  segments.pop(); // route.ts
  const path = segments
    .map((segment) =>
      segment.startsWith('[') && segment.endsWith(']')
        ? `{${segment.slice(1, -1)}}`
        : segment
    )
    .join('/');
  return path ? `/${path}` : '/';
}

/**
 * Los métodos que el archivo exporta. Se lee el texto en vez de
 * importar el módulo porque importar una route handler arrastra
 * Supabase, el limitador y media aplicación: aquí solo interesa la
 * firma pública del archivo.
 */
function exportedMethods(source: string): HttpMethod[] {
  const found: HttpMethod[] = [];
  for (const method of HTTP_METHODS) {
    const pattern = new RegExp(
      `^export\\s+(?:async\\s+)?function\\s+${method.toUpperCase()}\\s*\\(`,
      'm'
    );
    if (pattern.test(source)) found.push(method);
  }
  return found;
}

function discoverOperations(): DiscoveredOperation[] {
  return walkRouteFiles(ROUTES_ROOT).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return exportedMethods(source).map((method) => ({
      method,
      path: routePathFromFile(file),
      file: relative(process.cwd(), file),
    }));
  });
}

function documentedOperations(): string[] {
  const document = buildOpenApiDocument();
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`)
  );
}

describe('cobertura del documento OpenAPI', () => {
  const discovered = discoverOperations();
  const inCode = discovered
    .map((op) => `${op.method.toUpperCase()} ${op.path}`)
    .sort();
  const inDocument = documentedOperations().sort();

  it('encuentra rutas en el disco (el recorrido no está roto)', () => {
    // Una regresión silenciosa en `walkRouteFiles` dejaría el test en
    // verde comparando dos listas vacías. Este número es el inventario
    // de a7.5 (§6 de progress/impl_integracion-api-3.md).
    expect(discovered.length).toBe(37);
  });

  it('documenta TODA operación que existe en src/app/api/v1', () => {
    const missing = inCode.filter((op) => !inDocument.includes(op));
    expect(
      missing,
      `Estas rutas existen en el código y no están en el documento OpenAPI. ` +
        `Añádelas al registro de src/lib/api/v1/openapi/:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('no documenta ninguna operación que ya no existe en el código', () => {
    const extra = inDocument.filter((op) => !inCode.includes(op));
    expect(
      extra,
      `El documento OpenAPI promete estas operaciones y no hay ruta que las sirva:\n  ${extra.join('\n  ')}`
    ).toEqual([]);
  });

  it('servers[0].url + la clave de paths reconstruye la URL del disco', () => {
    // El prefijo va en UN solo sitio: el servidor. Si alguien lo
    // vuelve a meter en las claves de `paths`, aquí sale
    // `/api/v1/api/v1/contacts` y este test lo caza — que es
    // exactamente lo que se coló en la primera ronda.
    const { servers, paths } = buildOpenApiDocument();
    expect(API_BASE_PATH).toBe(URL_PREFIX_FROM_DISK);
    expect(servers[0].url).toBe(URL_PREFIX_FROM_DISK);

    const compuestas = Object.keys(paths)
      .map((path) => `${servers[0].url}${path}`)
      .sort();
    const enDisco = [
      ...new Set(discovered.map((op) => `${URL_PREFIX_FROM_DISK}${op.path}`)),
    ].sort();
    expect(compuestas).toEqual(enDisco);
  });

  it('no deja fuera la ruta del propio documento por accidente', () => {
    // La exclusión es deliberada y acotada: si alguien la ampliara, este
    // test lo enseña.
    expect([...EXCLUDED_ROUTE_FILES]).toEqual(['openapi.json']);
    expect(discovered.some((op) => op.path.includes('openapi.json'))).toBe(
      false
    );
  });

  it('cada operación documentada declara scopes y cubos de rate limit', () => {
    const document = buildOpenApiDocument();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect(operation['x-scopes'], where).toBeDefined();
        // `publicApi` lo aplica `requireApiKey` a todas: si falta, el
        // documento estaría mintiendo sobre el límite por clave.
        expect(
          operation['x-rate-limits'].map((r) => r.bucket),
          where
        ).toContain('publicApi');
      }
    }
  });
});
