// ============================================================
// La ruta del contrato: pública, cacheable y revalidable.
//
// No hay mocks de Supabase aquí a propósito: si alguien metiera una
// consulta o un `requireApiKey` en esta ruta, estos tests fallarían al
// intentar hablar con una base que no existe. Que pasen sin mock
// alguno ES la comprobación de que la ruta no toca datos de nadie.
// ============================================================

import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '@/lib/api/v1/openapi/document';

import { GET } from './route';

const URL_OPENAPI = 'https://crm.example.com/api/v1/openapi.json';

function request(headers: Record<string, string> = {}): Request {
  return new Request(URL_OPENAPI, { headers });
}

describe('GET /api/v1/openapi.json', () => {
  it('responde 200 SIN credencial alguna', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
  });

  it('devuelve el documento que genera buildOpenApiDocument', async () => {
    const res = await GET(request());
    const body = await res.json();
    expect(body).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
    expect(body.openapi).toBe('3.1.0');
    expect(Object.keys(body.paths)).toHaveLength(25);
  });

  it('sirve JSON', async () => {
    const res = await GET(request());
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('se cachea largo: no es `no-store` como el resto de /api/v1', async () => {
    const res = await GET(request());
    const cacheControl = res.headers.get('cache-control') ?? '';
    expect(cacheControl).toContain('public');
    expect(cacheControl).toContain('max-age=3600');
    expect(cacheControl).not.toContain('no-store');
  });

  it('lleva un ETag fuerte y entrecomillado', async () => {
    const etag = (await GET(request())).headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it('el ETag es estable entre llamadas (mismo documento, mismos bytes)', async () => {
    const first = (await GET(request())).headers.get('etag');
    const second = (await GET(request())).headers.get('etag');
    expect(second).toBe(first);
  });

  it('con el ETag correcto responde 304 y sin cuerpo', async () => {
    const etag = (await GET(request())).headers.get('etag')!;
    const res = await GET(request({ 'If-None-Match': etag }));
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    // El 304 repite ETag y Cache-Control: sin ellos el cliente no
    // sabría cuánto vale su copia.
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('cache-control')).toContain('max-age=3600');
  });

  it('acepta el ETag debilitado por un intermediario', async () => {
    const etag = (await GET(request())).headers.get('etag')!;
    const res = await GET(request({ 'If-None-Match': `W/${etag}` }));
    expect(res.status).toBe(304);
  });

  it('acepta una lista de ETags y el comodín', async () => {
    const etag = (await GET(request())).headers.get('etag')!;
    expect(
      (await GET(request({ 'If-None-Match': `"otro", ${etag}` }))).status
    ).toBe(304);
    expect((await GET(request({ 'If-None-Match': '*' }))).status).toBe(304);
  });

  it('con un ETag viejo devuelve el documento entero', async () => {
    const res = await GET(request({ 'If-None-Match': '"de-otro-despliegue"' }));
    expect(res.status).toBe(200);
    expect((await res.json()).openapi).toBe('3.1.0');
  });

  it('no filtra ninguna credencial', async () => {
    // El documento describe la FORMA de la API, y nombra los prefijos
    // `wacrm_live_` y `whsec_` porque hay que explicarlos. Lo que aquí
    // se caza es una clave ENTERA copiada y pegada: el prefijo seguido
    // de una cadena con pinta de secreto de verdad.
    const body = await (await GET(request())).text();
    expect(body).not.toMatch(/wacrm_live_[A-Za-z0-9_-]{20,}/);
    expect(body).not.toMatch(/whsec_[A-Za-z0-9_-]{30,}/);
    expect(body).not.toContain('service_role');
    expect(body).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
