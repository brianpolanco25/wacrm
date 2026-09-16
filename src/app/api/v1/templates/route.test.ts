import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// Fase 7 §3 — `GET /api/v1/templates` y `POST /api/v1/templates`.
//
// Meta está simulado en el sitio donde vive de verdad: `global.fetch`. Lo
// que se afirma no es "la ruta devolvió 201", sino QUÉ se le mandó a Meta y
// qué quedó en la tabla — un test que solo mirara el código de estado
// pasaría con una ruta que envía el cuerpo equivocado.
//
// La base es `fake-supabase.ts`, sembrada con dos cuentas: A (la de la
// clave) y B, cuya plantilla comparte nombre y cuerpo con las de A para que
// un filtro perdido salga en la lista.
// ---------------------------------------------------------------------------

const A = 'acct-a';
const B = 'acct-b';
const USER_A = '11111111-1111-4111-8111-111111111111';

const TPL_PROMO = 'aaaaaaaa-0000-4000-8000-000000000001';
const TPL_INVOICE = 'aaaaaaaa-0000-4000-8000-000000000002';
const TPL_DRAFT = 'aaaaaaaa-0000-4000-8000-000000000003';
const TPL_B = 'bbbbbbbb-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  scopes: ['templates:read', 'templates:write'] as string[],
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async (_request: Request, scope?: string) => {
    if (scope && !h.scopes.includes(scope)) {
      throw new Error(`missing scope ${scope}`);
    }
    return {
      authType: 'api_key',
      supabase: h.db.admin,
      accountId: A,
      keyId: 'key-a',
      scopes: h.scopes,
      createdBy: USER_A,
    };
  },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

import { encrypt } from '@/lib/whatsapp/encryption';
import { GET, POST } from './route';

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
        body_text: 'Hello {{1}}, your order {{2}} shipped',
        sample_values: { body: ['Ada', 'A-1'] },
        meta_template_id: 'meta-b',
        created_at: '2026-03-04T00:00:00Z',
      },
      {
        id: TPL_PROMO,
        account_id: A,
        user_id: USER_A,
        name: 'promo',
        language: 'en_US',
        category: 'Marketing',
        status: 'APPROVED',
        body_text: 'Hello {{1}}, your order {{2}} shipped',
        sample_values: { body: ['Ada', 'A-1'] },
        footer_text: 'Reply STOP to opt out',
        buttons: [{ type: 'QUICK_REPLY', text: 'Thanks' }],
        meta_template_id: 'meta-a-promo',
        created_at: '2026-03-03T00:00:00Z',
      },
      {
        id: TPL_INVOICE,
        account_id: A,
        user_id: USER_A,
        name: 'invoice',
        language: 'es_ES',
        category: 'Utility',
        status: 'PENDING',
        body_text: 'Tu factura {{1}}',
        sample_values: { body: ['F-9'] },
        meta_template_id: 'meta-a-invoice',
        created_at: '2026-03-02T00:00:00Z',
      },
      {
        id: TPL_DRAFT,
        account_id: A,
        user_id: USER_A,
        name: 'reminder',
        language: 'en_US',
        category: 'Marketing',
        status: 'REJECTED',
        body_text: 'Just a reminder',
        rejection_reason: 'INVALID_FORMAT',
        meta_template_id: 'meta-a-reminder',
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

/** Meta acepta y devuelve el id de la plantilla creada. */
function metaAccepts() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'meta-new-1', status: 'PENDING' }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const NEW_TEMPLATE = {
  name: 'welcome_back',
  language: 'en_US',
  category: 'marketing',
  body_text: 'Welcome back {{1}}!',
  footer_text: 'Cabbity',
  sample_values: { body: ['Ada'] },
};

beforeEach(() => {
  h.db = seed();
  h.scopes = ['templates:read', 'templates:write'];
  delete process.env.WHATSAPP_TEMPLATES_DRY_RUN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/v1/templates', () => {
  it('lista solo las de la cuenta de la clave, con las variables del cuerpo en orden', async () => {
    const res = await GET(req('GET', '/api/v1/templates'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.map((t: Row) => t.id)).toEqual([
      TPL_PROMO,
      TPL_INVOICE,
      TPL_DRAFT,
    ]);
    expect(JSON.stringify(json)).not.toContain(TPL_B);

    const promo = json.data[0];
    expect(promo.variables).toEqual([
      { index: 1, placeholder: '{{1}}', example: 'Ada' },
      { index: 2, placeholder: '{{2}}', example: 'A-1' },
    ]);
    // La forma pública no expone las columnas internas de tenencia.
    expect(promo.account_id).toBeUndefined();
    expect(promo.user_id).toBeUndefined();
    expect(promo.components).toMatchObject({
      body: { text: 'Hello {{1}}, your order {{2}} shipped' },
      footer: { text: 'Reply STOP to opt out' },
      buttons: [{ type: 'QUICK_REPLY', text: 'Thanks' }],
      header: null,
    });
  });

  it('una plantilla sin variables sale con la lista vacía, no sin el campo', async () => {
    const res = await GET(req('GET', '/api/v1/templates?status=rejected'));
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      id: TPL_DRAFT,
      status: 'REJECTED',
      rejection_reason: 'INVALID_FORMAT',
      variables: [],
    });
  });

  it('filtra por idioma y por categoría sin distinguir mayúsculas', async () => {
    const byLang = await (
      await GET(req('GET', '/api/v1/templates?language=es_ES'))
    ).json();
    expect(byLang.data.map((t: Row) => t.id)).toEqual([TPL_INVOICE]);

    const byCategory = await (
      await GET(req('GET', '/api/v1/templates?category=marketing'))
    ).json();
    expect(byCategory.data.map((t: Row) => t.id)).toEqual([
      TPL_PROMO,
      TPL_DRAFT,
    ]);
  });

  it('busca en el nombre y en el cuerpo, y nunca cruza de cuenta', async () => {
    // `order` solo aparece en el CUERPO de `promo` — y también en el de la
    // plantilla de B, que no puede salir.
    const res = await GET(req('GET', '/api/v1/templates?search=order'));
    const json = await res.json();
    expect(json.data.map((t: Row) => t.id)).toEqual([TPL_PROMO]);

    const byName = await (
      await GET(req('GET', '/api/v1/templates?search=invo'))
    ).json();
    expect(byName.data.map((t: Row) => t.id)).toEqual([TPL_INVOICE]);
  });

  it('rechaza un estado que no existe en lugar de devolver una lista vacía', async () => {
    const res = await GET(req('GET', '/api/v1/templates?status=ALMOST'));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.code).toBe('bad_request');
    expect(json.error.message).toContain('PENDING');
  });

  it('pagina por keyset: la segunda página continúa donde acabó la primera', async () => {
    const first = await (
      await GET(req('GET', '/api/v1/templates?limit=2'))
    ).json();
    expect(first.data.map((t: Row) => t.id)).toEqual([TPL_PROMO, TPL_INVOICE]);
    expect(first.meta.next_cursor).toBeTruthy();

    const second = await (
      await GET(
        req(
          'GET',
          `/api/v1/templates?limit=2&cursor=${encodeURIComponent(first.meta.next_cursor)}`
        )
      )
    ).json();
    expect(second.data.map((t: Row) => t.id)).toEqual([TPL_DRAFT]);
    expect(second.meta.next_cursor).toBeNull();
  });
});

describe('POST /api/v1/templates', () => {
  it('valida, envía a Meta el cuerpo de componentes y guarda la fila en PENDING', async () => {
    const fetchMock = metaAccepts();

    const res = await POST(req('POST', '/api/v1/templates', NEW_TEMPLATE));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // La WABA del número, y el token descifrado — no el cifrado.
    expect(url).toContain('/waba-a/message_templates');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-a'
    );
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      name: 'welcome_back',
      language: 'en_US',
      category: 'MARKETING',
    });
    expect(sent.components).toEqual([
      {
        type: 'BODY',
        text: 'Welcome back {{1}}!',
        example: { body_text: [['Ada']] },
      },
      { type: 'FOOTER', text: 'Cabbity' },
    ]);

    // Y lo que quedó guardado, bajo la cuenta de la clave.
    const row = (h.db.rows('message_templates') as Row[]).find(
      (r) => r.name === 'welcome_back'
    )!;
    expect(row).toMatchObject({
      account_id: A,
      user_id: USER_A,
      status: 'PENDING',
      meta_template_id: 'meta-new-1',
      category: 'Marketing',
    });
    expect(json.data).toMatchObject({
      name: 'welcome_back',
      status: 'PENDING',
      variables: [{ index: 1, placeholder: '{{1}}', example: 'Ada' }],
    });
  });

  it('acepta `from` con el phone_number_id del cliente y usa esa WABA', async () => {
    const fetchMock = metaAccepts();
    await POST(
      req('POST', '/api/v1/templates', { ...NEW_TEMPLATE, from: 'pn-a' })
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain('/waba-a/');
  });

  it('un `from` que no es de la cuenta es 400 y no se envía nada a Meta', async () => {
    const fetchMock = metaAccepts();
    const res = await POST(
      req('POST', '/api/v1/templates', { ...NEW_TEMPLATE, from: 'pn-b' })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.message).toContain('connected number');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un (nombre, idioma) repetido es 409 antes de gastar el viaje a Meta', async () => {
    const fetchMock = metaAccepts();
    const res = await POST(
      req('POST', '/api/v1/templates', {
        ...NEW_TEMPLATE,
        name: 'promo',
        language: 'en_US',
      })
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error.code).toBe('conflict');
    expect(json.error.message).toContain(TPL_PROMO);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el mismo par que tiene OTRA cuenta sí se puede crear', async () => {
    // `promo`/`es_ES` solo existe en B: la unicidad es por cuenta, y una
    // comprobación sin acotar bloquearía a A por una fila ajena.
    h.db.rows('message_templates').push({
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      account_id: B,
      user_id: 'user-b',
      name: 'welcome_back',
      language: 'en_US',
      category: 'Marketing',
      status: 'APPROVED',
      body_text: 'B got here first',
      created_at: '2026-03-05T00:00:00Z',
    });
    metaAccepts();

    const res = await POST(req('POST', '/api/v1/templates', NEW_TEMPLATE));
    expect(res.status).toBe(201);
  });

  it('un rechazo de Meta sale como meta_error 502 con su código público y no escribe nada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: 'Template name is already in use',
            code: 2388023,
            type: 'OAuthException',
          },
        }),
      }))
    );

    const before = h.db.rows('message_templates').length;
    const res = await POST(req('POST', '/api/v1/templates', NEW_TEMPLATE));
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toMatchObject({
      code: 'meta_error',
      message: 'Template name is already in use',
      meta_code: 2388023,
    });
    expect(json.error.request_id).toBeTruthy();
    // Nada del servidor: ni la URL llamada, ni el token, ni SQL.
    expect(JSON.stringify(json)).not.toContain('token-a');
    expect(JSON.stringify(json)).not.toContain('graph.facebook.com');
    expect(h.db.rows('message_templates').length).toBe(before);
  });

  it('rechaza las de autenticación con la alternativa escrita en el mensaje', async () => {
    const fetchMock = metaAccepts();
    const res = await POST(
      req('POST', '/api/v1/templates', {
        ...NEW_TEMPLATE,
        category: 'Authentication',
      })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.message).toContain('/api/v1/templates/sync');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('devuelve el fallo del validador con el campo, no un 500', async () => {
    const fetchMock = metaAccepts();
    const gap = await POST(
      req('POST', '/api/v1/templates', {
        ...NEW_TEMPLATE,
        body_text: 'Hi {{1}} and {{3}}',
        sample_values: { body: ['Ada', 'Bob'] },
      })
    );
    const gapJson = await gap.json();
    expect(gap.status).toBe(400);
    expect(gapJson.error.message).toContain('contiguous');

    const badName = await POST(
      req('POST', '/api/v1/templates', {
        ...NEW_TEMPLATE,
        name: 'Welcome Back',
      })
    );
    expect(badName.status).toBe(400);
    expect((await badName.json()).error.message).toContain('lowercase');

    const badType = await POST(
      req('POST', '/api/v1/templates', { ...NEW_TEMPLATE, footer_text: 7 })
    );
    expect(badType.status).toBe(400);
    expect((await badType.json()).error.message).toContain("'footer_text'");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exige Content-Type JSON como toda escritura de /api/v1', async () => {
    const fetchMock = metaAccepts();
    const res = await POST(
      new Request('https://crm.test/api/v1/templates', {
        method: 'POST',
        headers: { authorization: 'Bearer wacrm_live_x' },
        body: JSON.stringify(NEW_TEMPLATE),
      })
    );
    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
