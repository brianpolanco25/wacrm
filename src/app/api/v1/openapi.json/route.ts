// ============================================================
// GET /api/v1/openapi.json — el contrato de la API pública.
//
// PÚBLICA a propósito: no pasa por `requireApiKey`. El documento
// describe la forma de la API, no los datos de nadie, y un cliente
// tiene que poder importarlo (o generar un SDK) ANTES de tener una
// clave. Es la única ruta bajo `/api/v1` sin credencial, y por eso
// tampoco toca la base de datos ni el contexto de cuenta: no hay nada
// que filtrar porque no se lee nada.
//
// Es también la única respuesta de `/api/v1` que NO lleva
// `Cache-Control: no-store`: el documento solo cambia cuando cambia el
// código, así que se cachea largo y se revalida con `ETag`. La
// excepción está escrita también en `next.config.ts`, donde la regla
// general de `/api/:path*` pone `no-store` (ver el comentario de allí).
// ============================================================

import { createHash } from 'node:crypto';

import { buildOpenApiDocument } from '@/lib/api/v1/openapi/document';

/**
 * Una hora en el navegador y una semana de `stale-while-revalidate`.
 * Largo porque el documento es estático entre despliegues, y seguro
 * porque el `ETag` hace que una copia caducada se revalide en un 304
 * de unos pocos bytes en vez de descargarse entera.
 */
const CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=604800';

/**
 * El documento se construye UNA vez por proceso. `buildOpenApiDocument`
 * es pura, así que el resultado —y por tanto el `ETag`— es el mismo
 * durante toda la vida del proceso y cambia solo al desplegar código
 * nuevo. Sin memoizar, cada petición reconstruiría ~330 KB de objetos
 * para acabar sirviendo los mismos bytes.
 */
let cached: { body: string; etag: string } | null = null;

function getDocument(): { body: string; etag: string } {
  if (!cached) {
    const body = JSON.stringify(buildOpenApiDocument(), null, 2);
    // ETag FUERTE (sin `W/`): los bytes son exactamente estos, no una
    // equivalencia semántica. Se cita por el RFC, comillas incluidas.
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    cached = { body, etag };
  }
  return cached;
}

/** ¿El `If-None-Match` del cliente cubre este `ETag`? */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some(
      (candidate) =>
        candidate === '*' ||
        candidate === etag ||
        // Un intermediario puede haber debilitado la etiqueta.
        candidate === `W/${etag}`
    );
}

export async function GET(request: Request) {
  const { body, etag } = getDocument();

  const baseHeaders: Record<string, string> = {
    ETag: etag,
    'Cache-Control': CACHE_CONTROL,
  };

  if (matchesEtag(request.headers.get('if-none-match'), etag)) {
    // 304 sin cuerpo: el cliente ya tiene estos bytes.
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  return new Response(body, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}
