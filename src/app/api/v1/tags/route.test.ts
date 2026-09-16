import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 7 §2 — las cinco operaciones de `tags` en la API pública:
// `GET|POST /api/v1/tags` y `GET|PATCH|DELETE /api/v1/tags/{id}`.
//
// La base es `fake-supabase.ts`, no una cadena de `vi.fn()`: evalúa las
// consultas de verdad contra dos cuentas sembradas, así que una ruta a la
// que se le caiga el `.eq('account_id', …)` devuelve aquí las filas de la
// otra cuenta y el test lo ve. Es la misma razón por la que la suite de
// aislamiento usa ese doble, y lo que hace que los casos de fuga de esta
// sección («una etiqueta de otra cuenta → 404») signifiquen algo.
//
// Lo que este archivo NO puede comprobar es la cascada
// `contact_tags → tags` del DELETE: la hace una FK de Postgres, no
// código. Va contra el Postgres del harness, en
// `progress/checks_tags-v1.sql`.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  /**
   * Cuando no es null, `findOrCreateTag` lanza esto en vez de trabajar.
   * Es la única forma de llegar a la rama del 23505 desde la ruta: el
   * doble en memoria no simula índices únicos, y lo que se comprueba
   * aquí no es la carrera (eso vive en `src/lib/api/v1/tags.test.ts`)
   * sino qué CÓDIGO de error publica la ruta cuando la carrera se
   * pierde del todo.
   */
  findOrCreateThrows: null as unknown,
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: h.requireApiKey,
}));

vi.mock('@/lib/api/v1/tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/tags')>();
  return {
    ...actual,
    findOrCreateTag: (...args: Parameters<typeof actual.findOrCreateTag>) => {
      if (h.findOrCreateThrows) throw h.findOrCreateThrows;
      return actual.findOrCreateTag(...args);
    },
  };
});

import { FakeDatabase } from '@/lib/security/fake-supabase';
import { MAX_BODY_BYTES } from '@/lib/api/v1/body';
import {
  DEFAULT_TAG_COLOR,
  MAX_TAG_NAME_LENGTH,
  TagError,
} from '@/lib/api/v1/tags';
import { GET, POST } from './route';
import {
  GET as GET_ONE,
  PATCH as PATCH_ONE,
  DELETE as DELETE_ONE,
} from './[id]/route';

const A = 'acct-a';
const B = 'acct-b';
const USER_A = '11111111-1111-4111-8111-111111111111';
// Ids reales: el cursor de paginación solo se acepta si su id parsea como
// UUID (`decodeCursor` rechaza cualquier otra cosa para que un cursor
// fabricado a mano no entre en el `.or()` de PostgREST).
const TAG_A1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const TAG_A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const TAG_B = 'bbbbbbbb-0000-4000-8000-000000000001';

/**
 * Las filas de B van primero en cada tabla y con el MISMO nombre de
 * etiqueta que las de A: una consulta sin `account_id` caería sobre la
 * de B y el test fallaría.
 */
function seed(): FakeDatabase {
  return new FakeDatabase({
    accounts: [
      { id: B, name: 'Beta', owner_user_id: 'user-b' },
      { id: A, name: 'Alpha', owner_user_id: USER_A },
    ],
    whatsapp_config: [],
    tags: [
      {
        id: TAG_B,
        account_id: B,
        user_id: 'user-b',
        name: 'VIP',
        color: '#111111',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: TAG_A1,
        account_id: A,
        user_id: USER_A,
        name: 'VIP',
        color: '#222222',
        created_at: '2026-02-01T00:00:00.000Z',
      },
      {
        id: TAG_A2,
        account_id: A,
        user_id: USER_A,
        name: 'Moroso',
        color: '#333333',
        created_at: '2026-03-01T00:00:00.000Z',
      },
    ],
    contact_tags: [],
    contacts: [],
  });
}

function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request(`https://crm.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Las filas de B, tal cual, para comprobar que nadie las tocó. */
function snapshotB() {
  return h.db.snapshot(B);
}

beforeEach(() => {
  h.db = seed();
  h.findOrCreateThrows = null;
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue({
    authType: 'api_key',
    supabase: h.db.admin,
    accountId: A,
    keyId: 'key-a',
    scopes: ['tags:read', 'tags:write'],
    createdBy: USER_A,
  });
});

describe('GET /api/v1/tags', () => {
  it('lista solo las etiquetas de la cuenta, de la más nueva a la más vieja', async () => {
    const res = await GET(req('GET', '/api/v1/tags'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((t: { id: string }) => t.id)).toEqual([
      TAG_A2,
      TAG_A1,
    ]);
    expect(body.meta.next_cursor).toBeNull();
  });

  it('pide el scope tags:read', async () => {
    await GET(req('GET', '/api/v1/tags'));
    expect(h.requireApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      'tags:read'
    );
  });

  it('con ?search= devuelve la etiqueta de ESTA cuenta, no la homónima de la otra', async () => {
    const res = await GET(req('GET', '/api/v1/tags?search=vip'));
    const body = await res.json();

    // Las dos cuentas tienen una etiqueta llamada «VIP». La búsqueda es
    // insensible a mayúsculas y, sobre todo, acotada.
    expect(body.data.map((t: { id: string }) => t.id)).toEqual([TAG_A1]);
  });

  it('pagina por cursor: una página por etiqueta y el cursor lleva a la siguiente', async () => {
    const first = await GET(req('GET', '/api/v1/tags?limit=1'));
    const firstBody = await first.json();
    expect(firstBody.data.map((t: { id: string }) => t.id)).toEqual([TAG_A2]);
    expect(typeof firstBody.meta.next_cursor).toBe('string');

    const second = await GET(
      req(
        'GET',
        `/api/v1/tags?limit=1&cursor=${encodeURIComponent(firstBody.meta.next_cursor)}`
      )
    );
    const secondBody = await second.json();
    expect(secondBody.data.map((t: { id: string }) => t.id)).toEqual([TAG_A1]);
    expect(secondBody.meta.next_cursor).toBeNull();
  });

  it('sirve el sobre de v1: Cache-Control no-store y X-Request-Id', async () => {
    const res = await GET(req('GET', '/api/v1/tags'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

describe('POST /api/v1/tags', () => {
  it('un choque irrecuperable con el índice único sale como conflict 409, no como internal', async () => {
    // `findOrCreateTag` solo lanza un TagError 409 cuando perdió la
    // carrera contra el índice de la migración 064 Y la relectura no
    // alcanza la fila ganadora. La ruta tiene que publicar eso como
    // `conflict`: un `internal` invitaría al cliente a reintentar algo
    // que va a volver a chocar.
    h.findOrCreateThrows = new TagError('Tag name already in use', 409);

    const res = await POST(req('POST', '/api/v1/tags', { name: 'Moroso' }));

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('conflict');
  });

  it('crea una etiqueta nueva con 201, acotada a la cuenta', async () => {
    const res = await POST(
      req('POST', '/api/v1/tags', { name: 'Fidelizado', color: '#ABC' })
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.name).toBe('Fidelizado');
    // `#ABC` se normaliza a `#rrggbb` en minúsculas antes de guardarse.
    expect(body.data.color).toBe('#aabbcc');

    const row = h.db.rows('tags').find((t) => t.id === body.data.id);
    expect(row?.account_id).toBe(A);
    expect(row?.user_id).toBe(USER_A);
  });

  it('sin color usa el mismo por defecto que el panel', async () => {
    const res = await POST(req('POST', '/api/v1/tags', { name: 'Nuevo' }));
    const body = await res.json();
    expect(body.data.color).toBe(DEFAULT_TAG_COLOR);
  });

  it('un nombre que ya existe (en otra caja) devuelve 200 con la fila existente y no crea otra', async () => {
    const before = h.db.rows('tags').length;
    const res = await POST(req('POST', '/api/v1/tags', { name: '  vip  ' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.id).toBe(TAG_A1);
    // Y no repinta: quien repite un nombre está nombrando, no pintando.
    expect(body.data.color).toBe('#222222');
    expect(h.db.rows('tags')).toHaveLength(before);
  });

  it('el homónimo de la otra cuenta no cuenta como existente: crea el suyo', async () => {
    // Si `findTagByName` se olvidara del `account_id`, «VIP» resolvería a
    // `tag-b`. Se comprueba desde la cuenta que NO tiene esa etiqueta.
    h.db.tables.tags = h.db.rows('tags').filter((t) => t.id !== TAG_A1);
    const beforeB = snapshotB();

    const res = await POST(req('POST', '/api/v1/tags', { name: 'VIP' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.id).not.toBe(TAG_B);
    expect(snapshotB()).toEqual(beforeB);
  });

  it('pide el scope tags:write', async () => {
    await POST(req('POST', '/api/v1/tags', { name: 'X' }));
    expect(h.requireApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      'tags:write'
    );
  });

  it('rechaza un nombre vacío, ausente o demasiado largo sin escribir nada', async () => {
    const before = h.db.rows('tags').length;

    for (const body of [
      {},
      { name: '   ' },
      { name: 42 },
      { name: 'x'.repeat(MAX_TAG_NAME_LENGTH + 1) },
    ]) {
      const res = await POST(req('POST', '/api/v1/tags', body));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('bad_request');
      expect(json.error.message).toContain('name');
    }

    expect(h.db.rows('tags')).toHaveLength(before);
  });

  it('rechaza un color que no es hexadecimal', async () => {
    const res = await POST(
      req('POST', '/api/v1/tags', {
        name: 'Rojo',
        color: 'red; background:url(x)',
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain('color');
    expect(h.db.rows('tags').some((t) => t.name === 'Rojo')).toBe(false);
  });

  it('exige Content-Type: application/json y respeta el tope de 1 MiB', async () => {
    const plain = await POST(
      new Request('https://crm.test/api/v1/tags', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{"name":"X"}',
      })
    );
    expect(plain.status).toBe(415);

    const huge = await POST(
      new Request('https://crm.test/api/v1/tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', note: 'x'.repeat(MAX_BODY_BYTES) }),
      })
    );
    expect(huge.status).toBe(413);
    expect(h.db.rows('tags')).toHaveLength(3);
  });
});

describe('GET /api/v1/tags/{id}', () => {
  it('devuelve la etiqueta propia', async () => {
    const res = await GET_ONE(
      req('GET', `/api/v1/tags/${TAG_A1}`),
      params(TAG_A1)
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      id: TAG_A1,
      name: 'VIP',
      color: '#222222',
      created_at: '2026-02-01T00:00:00.000Z',
    });
  });

  it('con el id de otra cuenta responde 404, nunca 403 ni la fila', async () => {
    const res = await GET_ONE(
      req('GET', `/api/v1/tags/${TAG_B}`),
      params(TAG_B)
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(JSON.stringify(body)).not.toContain(TAG_B);
  });
});

describe('PATCH /api/v1/tags/{id}', () => {
  it('renombra y repinta la etiqueta propia', async () => {
    const res = await PATCH_ONE(
      req('PATCH', `/api/v1/tags/${TAG_A2}`, {
        name: 'Deudor',
        color: '#00FF00',
      }),
      params(TAG_A2)
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.name).toBe('Deudor');
    expect(body.data.color).toBe('#00ff00');
    expect(h.db.rows('tags').find((t) => t.id === TAG_A2)?.name).toBe('Deudor');
  });

  it('acepta cambiar solo la caja del propio nombre', async () => {
    const res = await PATCH_ONE(
      req('PATCH', `/api/v1/tags/${TAG_A1}`, { name: 'vip' }),
      params(TAG_A1)
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('vip');
  });

  it('rechaza con 409 renombrar sobre un nombre que la cuenta ya usa', async () => {
    const res = await PATCH_ONE(
      req('PATCH', `/api/v1/tags/${TAG_A2}`, { name: 'vip' }),
      params(TAG_A2)
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('conflict');
    expect(h.db.rows('tags').find((t) => t.id === TAG_A2)?.name).toBe('Moroso');
  });

  it('el nombre que usa la OTRA cuenta no estorba', async () => {
    // `tag-b` también se llama «VIP»; renombrar a «VIP» en A solo choca
    // con `tag-a1`, así que se borra primero para dejar el nombre libre.
    h.db.tables.tags = h.db.rows('tags').filter((t) => t.id !== TAG_A1);
    const res = await PATCH_ONE(
      req('PATCH', `/api/v1/tags/${TAG_A2}`, { name: 'VIP' }),
      params(TAG_A2)
    );
    expect(res.status).toBe(200);
  });

  it('con el id de otra cuenta responde 404 y no toca su fila', async () => {
    const before = snapshotB();
    const res = await PATCH_ONE(
      req('PATCH', `/api/v1/tags/${TAG_B}`, { name: 'pwned' }),
      params(TAG_B)
    );
    expect(res.status).toBe(404);
    expect(snapshotB()).toEqual(before);
  });

  it('sin campos actualizables es 400', async () => {
    const res = await PATCH_ONE(
      req('PATCH', `/api/v1/tags/${TAG_A1}`, { nombre: 'ignorado' }),
      params(TAG_A1)
    );
    expect(res.status).toBe(400);
  });

  it('exige Content-Type: application/json', async () => {
    const res = await PATCH_ONE(
      new Request(`https://crm.test/api/v1/tags/${TAG_A1}`, {
        method: 'PATCH',
        headers: { 'content-type': 'text/plain' },
        body: '{"name":"X"}',
      }),
      params(TAG_A1)
    );
    expect(res.status).toBe(415);
  });
});

describe('DELETE /api/v1/tags/{id}', () => {
  it('borra la etiqueta propia', async () => {
    const res = await DELETE_ONE(
      req('DELETE', `/api/v1/tags/${TAG_A2}`),
      params(TAG_A2)
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: TAG_A2, deleted: true });
    expect(h.db.rows('tags').some((t) => t.id === TAG_A2)).toBe(false);
  });

  it('con el id de otra cuenta responde 404 y la deja donde estaba', async () => {
    const before = snapshotB();
    const res = await DELETE_ONE(
      req('DELETE', `/api/v1/tags/${TAG_B}`),
      params(TAG_B)
    );
    expect(res.status).toBe(404);
    expect(h.db.rows('tags').some((t) => t.id === TAG_B)).toBe(true);
    expect(snapshotB()).toEqual(before);
  });
});
