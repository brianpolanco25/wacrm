import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// Fase 7 §3 / S-A7 — `POST /api/v1/templates/sync`.
//
// El cubo propio es la razón de ser de este archivo. Una llamada recorre
// hasta 20 páginas de la Graph API y reescribe la tabla entera: si valiera
// el límite general por clave (120/min), un cliente con un bucle de sondeo
// le metería a Meta 120 recorridos por minuto y se llevaría el rate limit
// de la WABA por delante, que afecta al ENVÍO de mensajes. Por eso el cubo
// es 6/min y va por CUENTA, no por clave.
//
// El resto de lo que se prueba aquí es lo que la ruta añade sobre
// `template-sync.ts` (que tiene su propia suite): el scope, el número
// elegido, la forma de la respuesta y el cuerpo opcional.
// ---------------------------------------------------------------------------

const A = 'acct-a';
const B = 'acct-b';
const USER_A = '11111111-1111-4111-8111-111111111111';
const TPL_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TPL_B = 'bbbbbbbb-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  accountId: 'acct-a',
  emitted: [] as { accountId: string; event: string; data: unknown }[],
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    authType: 'api_key',
    supabase: h.db.admin,
    accountId: h.accountId,
    keyId: 'key-a',
    scopes: ['templates:read', 'templates:write'],
    createdBy: USER_A,
  }),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

vi.mock('@/lib/webhooks/emit', () => ({
  emitWebhookEvent: async (accountId: string, event: string, data: unknown) => {
    h.emitted.push({ accountId, event, data });
  },
}));

import { encrypt } from '@/lib/whatsapp/encryption';
import { RATE_LIMITS, __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

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
        body_text: 'B body',
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
        status: 'PENDING',
        body_text: 'A body',
        meta_template_id: 'meta-a',
        created_at: '2026-03-03T00:00:00Z',
      },
    ],
  });
}

/** Meta devuelve `promo` ya aprobada y una plantilla nueva. */
function metaCatalog() {
  const fetchMock = vi.fn<FetchLike>(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [
        {
          id: 'meta-a',
          name: 'promo',
          language: 'en_US',
          status: 'APPROVED',
          category: 'MARKETING',
          components: [{ type: 'BODY', text: 'A body' }],
        },
        {
          id: 'meta-new',
          name: 'welcome',
          language: 'en_US',
          status: 'PENDING',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: 'Welcome {{1}}' }],
        },
      ],
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function req(body?: unknown, path = '/api/v1/templates/sync'): Request {
  const headers: Record<string, string> = {
    authorization: 'Bearer wacrm_live_x',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://crm.test${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  h.db = seed();
  h.accountId = A;
  h.emitted = [];
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetRateLimitForTests();
});

describe('POST /api/v1/templates/sync', () => {
  it('sincroniza sin cuerpo y devuelve el recuento con los cambios de estado', async () => {
    const fetchMock = metaCatalog();

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    // La WABA y el token del número de la cuenta, no los de la otra.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/waba-a/message_templates');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-a'
    );

    expect(json.data).toMatchObject({
      synced: 2,
      created: 1,
      updated: 1,
      errors: [],
      truncated: false,
    });
    expect(json.data.status_changes).toEqual([
      {
        template_id: TPL_A,
        name: 'promo',
        language: 'en_US',
        status: 'APPROVED',
        previous_status: 'PENDING',
      },
    ]);
    // Y el mismo cambio salió por los webhooks de la cuenta (fase 7 §4).
    expect(h.emitted).toEqual([
      {
        accountId: A,
        event: 'template.status_updated',
        data: json.data.status_changes[0],
      },
    ]);
  });

  it('acepta `Content-Type: application/json` con el cuerpo vacío', async () => {
    // `curl -X POST -H 'Content-Type: application/json'` sin `-d`. Exigir
    // un `{}` literal para poder sincronizar sería una trampa sin nada al
    // otro lado; el resto de controles del cuerpo siguen valiendo.
    metaCatalog();
    const res = await POST(
      new Request('https://crm.test/api/v1/templates/sync', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wacrm_live_x',
          'content-type': 'application/json',
        },
      })
    );
    expect(res.status).toBe(200);

    __resetRateLimitForTests();
    const broken = await POST(
      new Request('https://crm.test/api/v1/templates/sync', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wacrm_live_x',
          'content-type': 'application/json',
        },
        body: '[]',
      })
    );
    expect(broken.status).toBe(400);
  });

  it('escribe solo dentro de la cuenta de la clave', async () => {
    metaCatalog();
    const before = h.db.snapshot(B);

    await POST(req());

    // `promo`/`en_US` existe en las dos cuentas: la de B queda intacta.
    expect(h.db.snapshot(B)).toEqual(before);
    const rows = h.db.rows('message_templates') as Row[];
    expect(rows.find((r) => r.id === TPL_A)?.status).toBe('APPROVED');
    expect(rows.find((r) => r.name === 'welcome')?.account_id).toBe(A);
  });

  it('acepta un cuerpo para elegir el número y rechaza uno ajeno', async () => {
    const fetchMock = metaCatalog();

    const own = await POST(req({ from: 'pn-a' }));
    expect(own.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/waba-a/');

    __resetRateLimitForTests();
    const foreign = await POST(req({ from: 'pn-b' }));
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).error.message).toContain('connected number');
    // No se llamó a Meta una segunda vez.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it(`responde 429 con Retry-After a partir de la llamada ${RATE_LIMITS.templatesSync.limit + 1} del minuto`, async () => {
    const fetchMock = metaCatalog();

    for (let i = 0; i < RATE_LIMITS.templatesSync.limit; i++) {
      const res = await POST(req());
      expect(res.status, `llamada ${i + 1}`).toBe(200);
    }

    const blocked = await POST(req());
    const json = await blocked.json();

    expect(blocked.status).toBe(429);
    expect(json.error.code).toBe('rate_limited');
    const retryAfter = Number(blocked.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(
      RATE_LIMITS.templatesSync.windowMs / 1000
    );
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe(
      String(RATE_LIMITS.templatesSync.limit)
    );
    expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');
    // Lo que el cubo protege es Meta: la llamada de más no sale.
    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMITS.templatesSync.limit);
  });

  it('el cubo es por cuenta: agotarlo en una no bloquea a la otra', async () => {
    metaCatalog();
    for (let i = 0; i < RATE_LIMITS.templatesSync.limit; i++) {
      await POST(req());
    }
    expect((await POST(req())).status).toBe(429);

    // Misma clave de prueba, otra cuenta: su cubo está intacto.
    h.accountId = B;
    expect((await POST(req())).status).toBe(200);
  });

  it('un error de Meta sale como meta_error 502 sin filtrar el token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchLike>(async () => ({
        ok: false,
        status: 401,
        json: async () => ({
          error: { message: 'Invalid OAuth access token', code: 190 },
        }),
      }))
    );

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toMatchObject({
      code: 'meta_error',
      message: 'Invalid OAuth access token',
    });
    expect(JSON.stringify(json)).not.toContain('token-a');
  });

  it('una cuenta sin número conectado recibe 400, no un 500', async () => {
    metaCatalog();
    h.db.tables.whatsapp_config = h.db.tables.whatsapp_config.filter(
      (r) => r.account_id !== A
    );
    const res = await POST(req());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('whatsapp_not_configured');
  });
});
