import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// Fase 7 §3 — `GET|PATCH|DELETE /api/v1/templates/{id}`.
//
// Dos cosas concentran casi todo el riesgo de estas tres rutas:
//
//   1. La lista de `variables`. Es el único dato del recurso que no está en
//      ninguna columna: se deriva del cuerpo. Es lo que un integrador usa
//      para saber cuántos `params` mandarle a `POST /api/v1/messages` con
//      `type=template`, así que si sale desordenada o incompleta, los
//      mensajes salen con los datos cambiados de sitio.
//   2. La herencia del `PATCH`. Meta REEMPLAZA los componentes en cada
//      edición: un parcheo que mandara solo lo recibido borraría el pie de
//      página o los botones sin que nadie lo pidiera.
//
// Meta está simulado en `global.fetch`, y la base es `fake-supabase.ts` con
// dos cuentas cuyas plantillas comparten nombre e idioma.
// ---------------------------------------------------------------------------

const A = 'acct-a';
const B = 'acct-b';
const USER_A = '11111111-1111-4111-8111-111111111111';

const TPL_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TPL_PENDING = 'aaaaaaaa-0000-4000-8000-000000000002';
const TPL_LOCAL = 'aaaaaaaa-0000-4000-8000-000000000003';
const TPL_B = 'bbbbbbbb-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    authType: 'api_key',
    supabase: h.db.admin,
    accountId: A,
    keyId: 'key-a',
    scopes: ['templates:read', 'templates:write'],
    createdBy: USER_A,
  }),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

import { encrypt } from '@/lib/whatsapp/encryption';
import { GET, PATCH, DELETE } from './route';

// Lo justo de `Response` que lee el código bajo prueba. Dar tipo al doble
// de `fetch` no es ceremonia: es lo que hace que `mock.calls[0]` tenga la
// URL y el `init` tipados, y por tanto que las aserciones sobre lo que se
// le mandó a Meta se comprueben en vez de colarse por `any`.
type MetaResponse = Pick<Response, 'ok' | 'status' | 'json'>;
type FetchLike = (url: string, init?: RequestInit) => Promise<MetaResponse>;

function seed(): FakeDatabase {
  return new FakeDatabase({
    whatsapp_config: [
      {
        id: 'cfg-b',
        account_id: B,
        user_id: 'user-b',
        phone_number_id: 'pn-b',
        waba_id: 'waba-b',
        access_token: encrypt('token-b'),
        is_default: true,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'cfg-a',
        account_id: A,
        user_id: USER_A,
        phone_number_id: 'pn-a',
        waba_id: 'waba-a',
        access_token: encrypt('token-a'),
        is_default: true,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    message_templates: [
      {
        id: TPL_B,
        account_id: B,
        user_id: 'user-b',
        name: 'promo',
        language: 'en_US',
        category: 'Marketing',
        status: 'APPROVED',
        body_text: 'B body {{1}}',
        sample_values: { body: ['Bea'] },
        meta_template_id: 'meta-b',
        created_at: '2026-03-04T00:00:00Z',
      },
      {
        id: TPL_A,
        account_id: A,
        user_id: USER_A,
        name: 'promo',
        language: 'en_US',
        category: 'Marketing',
        status: 'APPROVED',
        // Escrito a propósito con el {{2}} ANTES que el {{1}}: el orden de
        // `variables` es el del índice, no el de aparición.
        body_text: 'Order {{2}} is ready, {{1}}',
        sample_values: { body: ['Ada', 'A-1'] },
        footer_text: 'Reply STOP to opt out',
        buttons: [{ type: 'QUICK_REPLY', text: 'Thanks' }],
        meta_template_id: 'meta-a',
        quality_score: 'GREEN',
        created_at: '2026-03-03T00:00:00Z',
      },
      {
        id: TPL_PENDING,
        account_id: A,
        user_id: USER_A,
        name: 'waiting',
        language: 'en_US',
        category: 'Marketing',
        status: 'PENDING',
        body_text: 'Still under review',
        meta_template_id: 'meta-a-waiting',
        created_at: '2026-03-02T00:00:00Z',
      },
      {
        id: TPL_LOCAL,
        account_id: A,
        user_id: USER_A,
        name: 'never_sent',
        language: 'en_US',
        category: 'Marketing',
        status: 'DRAFT',
        body_text: 'Draft body',
        meta_template_id: null,
        created_at: '2026-03-01T00:00:00Z',
      },
    ],
  });
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://crm.test${path}`, {
    method,
    headers: {
      authorization: 'Bearer wacrm_live_x',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function metaAccepts() {
  const fetchMock = vi.fn<FetchLike>(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  h.db = seed();
  delete process.env.WHATSAPP_TEMPLATES_DRY_RUN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/v1/templates/{id}', () => {
  it('expone las variables {{1}}…{{n}} del cuerpo en orden de índice, con su ejemplo', async () => {
    const res = await GET(
      req('GET', `/api/v1/templates/${TPL_A}`),
      params(TPL_A)
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.variables).toEqual([
      { index: 1, placeholder: '{{1}}', example: 'Ada' },
      { index: 2, placeholder: '{{2}}', example: 'A-1' },
    ]);
    expect(json.data).toMatchObject({
      id: TPL_A,
      name: 'promo',
      language: 'en_US',
      category: 'Marketing',
      status: 'APPROVED',
      quality_score: 'GREEN',
      meta_template_id: 'meta-a',
    });
  });

  it('el id de la otra cuenta es 404, no 403 ni la fila', async () => {
    const res = await GET(
      req('GET', `/api/v1/templates/${TPL_B}`),
      params(TPL_B)
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('not_found');
    expect(JSON.stringify(json)).not.toContain('B body');
  });

  it('un id que ni siquiera es un UUID es 404, no un 500 de Postgres', async () => {
    const res = await GET(
      req('GET', '/api/v1/templates/not-a-uuid'),
      params('not-a-uuid')
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/templates/{id}', () => {
  it('hereda lo que no viene en el cuerpo y reenvía a Meta los componentes completos', async () => {
    const fetchMock = metaAccepts();

    const res = await PATCH(
      req('PATCH', `/api/v1/templates/${TPL_A}`, {
        body_text: 'Order {{1}} is on its way',
        sample_values: { body: ['A-2'] },
      }),
      params(TPL_A)
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Se edita POR id de Meta — no por nombre, que borraría las dos
    // traducciones — y con el token de la cuenta.
    expect(url).toContain('/meta-a');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-a'
    );
    // El pie de página y el botón NO venían en el cuerpo y siguen ahí: sin
    // la herencia, esta edición los habría borrado en Meta.
    expect(JSON.parse(String(init.body)).components).toEqual([
      {
        type: 'BODY',
        text: 'Order {{1}} is on its way',
        example: { body_text: [['A-2']] },
      },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Thanks' }] },
    ]);

    // La revisión vuelve a empezar y el rastro del intento anterior se borra.
    expect(json.data).toMatchObject({ id: TPL_A, status: 'PENDING' });
    expect(json.data.variables).toEqual([
      { index: 1, placeholder: '{{1}}', example: 'A-2' },
    ]);
    const row = (h.db.rows('message_templates') as Row[]).find(
      (r) => r.id === TPL_A
    )!;
    expect(row.status).toBe('PENDING');
    expect(row.submission_error).toBeNull();
  });

  it('un `null` explícito sí borra el componente', async () => {
    const fetchMock = metaAccepts();
    await PATCH(
      req('PATCH', `/api/v1/templates/${TPL_A}`, {
        footer_text: null,
        buttons: null,
      }),
      params(TPL_A)
    );
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.components.map((c: { type: string }) => c.type)).toEqual([
      'BODY',
    ]);
  });

  it('no deja renombrar ni cambiar de idioma', async () => {
    const fetchMock = metaAccepts();
    const renamed = await PATCH(
      req('PATCH', `/api/v1/templates/${TPL_A}`, { name: 'promo_v2' }),
      params(TPL_A)
    );
    expect(renamed.status).toBe(400);
    expect((await renamed.json()).error.message).toContain('(name, language)');

    const relanguaged = await PATCH(
      req('PATCH', `/api/v1/templates/${TPL_A}`, { language: 'es_ES' }),
      params(TPL_A)
    );
    expect(relanguaged.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un estado no editable es 409 con la lista de los que sí, sin llamar a Meta', async () => {
    const fetchMock = metaAccepts();
    const res = await PATCH(
      req('PATCH', `/api/v1/templates/${TPL_PENDING}`, {
        body_text: 'New body',
      }),
      params(TPL_PENDING)
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error.message).toContain('APPROVED, REJECTED, PAUSED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una plantilla que nunca llegó a Meta se crea, no se edita', async () => {
    const fetchMock = metaAccepts();
    const res = await PATCH(
      req('PATCH', `/api/v1/templates/${TPL_LOCAL}`, { body_text: 'x' }),
      params(TPL_LOCAL)
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error.message).toContain('POST /api/v1/templates');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el id de la otra cuenta es 404 y su fila no se toca', async () => {
    const fetchMock = metaAccepts();
    const before = h.db.snapshot(B);
    const res = await PATCH(
      req('PATCH', `/api/v1/templates/${TPL_B}`, { body_text: 'pwned {{1}}' }),
      params(TPL_B)
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.snapshot(B)).toEqual(before);
  });

  it('un rechazo de Meta sale como meta_error 502 y queda anotado en la fila', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchLike>(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: 'Template edit limit reached', code: 2388042 },
        }),
      }))
    );

    const res = await PATCH(
      req('PATCH', `/api/v1/templates/${TPL_A}`, {
        body_text: 'New {{1}}',
        sample_values: { body: ['Ada'] },
      }),
      params(TPL_A)
    );
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toMatchObject({
      code: 'meta_error',
      message: 'Template edit limit reached',
      meta_code: 2388042,
    });
    const row = (h.db.rows('message_templates') as Row[]).find(
      (r) => r.id === TPL_A
    )!;
    // El motivo queda visible en la siguiente lectura, y el estado NO
    // avanza a PENDING: Meta no aceptó nada.
    expect(row.submission_error).toBe('Template edit limit reached');
    expect(row.status).toBe('APPROVED');
    expect(row.body_text).toBe('Order {{2}} is ready, {{1}}');
  });
});

describe('DELETE /api/v1/templates/{id}', () => {
  it('borra en Meta solo esta traducción y luego la fila local', async () => {
    const fetchMock = metaAccepts();

    const res = await DELETE(
      req('DELETE', `/api/v1/templates/${TPL_A}`),
      params(TPL_A)
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ id: TPL_A, deleted: true });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toContain('/waba-a/message_templates');
    expect(url.searchParams.get('name')).toBe('promo');
    // Sin `hsm_id`, Meta borraría TODOS los idiomas que comparten nombre.
    expect(url.searchParams.get('hsm_id')).toBe('meta-a');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');

    expect(
      (h.db.rows('message_templates') as Row[]).map((r) => r.id)
    ).not.toContain(TPL_A);
  });

  it('el id de la otra cuenta es 404 y no se llama a Meta', async () => {
    const fetchMock = metaAccepts();
    const before = h.db.snapshot(B);
    const res = await DELETE(
      req('DELETE', `/api/v1/templates/${TPL_B}`),
      params(TPL_B)
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.snapshot(B)).toEqual(before);
  });

  it('un `?from=` de otra cuenta no presta su WABA para el borrado', async () => {
    const fetchMock = metaAccepts();
    const res = await DELETE(
      req('DELETE', `/api/v1/templates/${TPL_A}?from=pn-b`),
      params(TPL_A)
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (h.db.rows('message_templates') as Row[]).map((r) => r.id)
    ).toContain(TPL_A);
  });
});
