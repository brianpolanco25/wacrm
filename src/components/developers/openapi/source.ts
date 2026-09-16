import { buildOpenApiDocument } from '@/lib/api/v1/openapi/document';

import type { OpenApiDocument } from './types';

// ============================================================
// Puente entre la página de referencia y el documento OpenAPI.
//
// El generador vive en `src/lib/api/v1/openapi/` (a7.6) y es el mismo
// que sirve `GET /api/v1/openapi.json`: la referencia y el contrato
// que se descarga un cliente salen del MISMO objeto, así que no pueden
// contradecirse. Que este sea el único punto de contacto es
// deliberado: el renderizador se prueba contra un documento OpenAPI 3.1
// cualquiera (`fixture.ts`), no contra el nuestro, así que no hereda
// las suposiciones del generador.
// ============================================================

/**
 * Origen de ejemplo cuando la instancia no declara el suyo.
 *
 * `buildOpenApiDocument` recibe un ORIGEN y pone él el prefijo
 * `/api/v1` (`resolveServerUrl` en `document.ts`), así que aquí no se
 * escribe nunca la ruta. Sin `NEXT_PUBLIC_SITE_URL` el documento
 * quedaría con un servidor relativo (`/api/v1`) y los `curl` de ejemplo
 * no se podrían copiar y pegar: un dominio de ejemplo se lee mejor que
 * una URL que curl no sabe resolver. Es la misma variable que ya usan
 * las invitaciones y el checkout (`src/lib/billing/checkout.ts`).
 */
export const EXAMPLE_ORIGIN = 'https://tu-dominio.example.com';

/** El origen que esta instancia enseña en los ejemplos. */
export function docsServerOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  return explicit ? explicit.replace(/\/+$/, '') : EXAMPLE_ORIGIN;
}

/** El documento que la página de referencia renderiza en servidor. */
export function getOpenApiDocument(): OpenApiDocument {
  return buildOpenApiDocument({
    serverUrl: docsServerOrigin(),
  }) as OpenApiDocument;
}
