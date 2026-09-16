import { OPENAPI_FIXTURE } from './fixture';
import type { OpenApiDocument } from './types';

// ============================================================
// Puente entre la página de referencia y el documento OpenAPI.
//
// El generador real vive en `src/lib/api/v1/openapi/` y lo construye
// a7.6 (`openapi-spec`), en la rama hermana `api/openapi`: cuando se
// fusionen, este archivo cambia UNA línea —la de abajo— y la referencia
// pasa a pintar el contrato de verdad sin tocar nada más:
//
//   import { buildOpenApiDocument } from '@/lib/api/v1/openapi';
//   export function getOpenApiDocument(): OpenApiDocument {
//     return buildOpenApiDocument() as OpenApiDocument;
//   }
//
// Que ese sea el único punto de contacto es deliberado: el renderizador
// se prueba contra un documento OpenAPI 3.1 cualquiera (el fixture), no
// contra el nuestro, así que no hereda las suposiciones del generador.
// ============================================================

/** El documento que la página de referencia renderiza en servidor. */
export function getOpenApiDocument(): OpenApiDocument {
  return OPENAPI_FIXTURE;
}

/** Ruta pública del documento, para enseñarla en la página. */
export const OPENAPI_PATH = '/api/v1/openapi.json';
