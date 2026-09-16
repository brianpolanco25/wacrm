import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 7 §2 — las dos operaciones que atan etiquetas a un contacto POR ID:
// `POST /api/v1/contacts/{id}/tags` y
// `DELETE /api/v1/contacts/{id}/tags/{tagId}`.
//
// El criterio del spec —«asignar una etiqueta por API dispara el mismo
// evento que el panel»— es el motivo de que aquí NO se mockee
// `tag-events.ts`: las rutas corren el escritor de verdad contra
// `fake-supabase.ts` y lo único doblado es la frontera (el motor de
// automatizaciones y el emisor de webhooks), que es donde se puede
// observar el evento. Mockear `addContactTagAndDispatch` habría dejado
// pasar una ruta que escribiera la fila a mano y no disparara nada.
//
// La otra mitad es la corrección que arrastra a7.4 (hallazgo 2 de
// `review_webhooks-durable.md`): `contact.tag_removed` solo sale cuando
// el DELETE quitó de verdad una fila.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  runAutomationsForTrigger: vi.fn(async () => {}),
  emitWebhookEvent: vi.fn(async () => {}),
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: h.requireApiKey,
}));

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}));

vi.mock('@/lib/webhooks/emit', () => ({
  emitWebhookEvent: h.emitWebhookEvent,
}));

import { FakeDatabase } from '@/lib/security/fake-supabase';
import { MAX_BODY_BYTES } from '@/lib/api/v1/body';
import { POST, MAX_TAG_IDS_PER_CALL } from './route';
import { DELETE } from './[tagId]/route';

const A = 'acct-a';
const B = 'acct-b';
const USER_A = '11111111-1111-4111-8111-111111111111';
const CONTACT_A = 'aaaaaaaa-1111-4000-8000-000000000001';
const CONTACT_B = 'bbbbbbbb-1111-4000-8000-000000000001';
const TAG_A1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const TAG_A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const TAG_B = 'bbbbbbbb-0000-4000-8000-000000000001';

/** B primero en cada tabla: una consulta sin acotar cae sobre sus filas. */
function seed(): FakeDatabase {
  const stamp = {
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  return new FakeDatabase({
    accounts: [
      { id: B, name: 'Beta', owner_user_id: 'user-b' },
      { id: A, name: 'Alpha', owner_user_id: USER_A },
    ],
    contacts: [
      { id: CONTACT_B, account_id: B, phone: '+15550000002', ...stamp },
      { id: CONTACT_A, account_id: A, phone: '+15550000001', ...stamp },
    ],
    tags: [
      { id: TAG_B, account_id: B, name: 'VIP', color: '#111111', ...stamp },
      { id: TAG_A1, account_id: A, name: 'VIP', color: '#222222', ...stamp },
      { id: TAG_A2, account_id: A, name: 'Moroso', color: '#333333', ...stamp },
    ],
    contact_tags: [],
  });
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://crm.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const postTo = (contactId: string, body: unknown) => ({
  request: req('POST', `/api/v1/contacts/${contactId}/tags`, body),
  ctx: { params: Promise.resolve({ id: contactId }) },
});

const deleteFrom = (contactId: string, tagId: string) => ({
  request: req('DELETE', `/api/v1/contacts/${contactId}/tags/${tagId}`),
  ctx: { params: Promise.resolve({ id: contactId, tagId }) },
});

function joins(): unknown[] {
  return h.db.rows('contact_tags');
}

beforeEach(() => {
  h.db = seed();
  h.runAutomationsForTrigger.mockClear();
  h.emitWebhookEvent.mockClear();
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

describe('POST /api/v1/contacts/{id}/tags', () => {
  it('ata las etiquetas y devuelve el contacto con ellas', async () => {
    const { request, ctx } = postTo(CONTACT_A, {
      tag_ids: [TAG_A1, TAG_A2],
    });
    const res = await POST(request, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.tags.map((t: { name: string }) => t.name).sort()).toEqual([
      'Moroso',
      'VIP',
    ]);
    expect(joins()).toHaveLength(2);
  });

  it('pide el scope tags:write', async () => {
    const { request, ctx } = postTo(CONTACT_A, { tag_ids: [TAG_A1] });
    await POST(request, ctx);
    expect(h.requireApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      'tags:write'
    );
  });

  it('dispara el MISMO evento que el panel: trigger tag_added y contact.tag_added', async () => {
    const { request, ctx } = postTo(CONTACT_A, { tag_ids: [TAG_A1] });
    await POST(request, ctx);

    // Automatizaciones: el disparador por etiqueta tiene que reaccionar
    // igual que si la hubiera puesto un agente desde la bandeja.
    expect(h.runAutomationsForTrigger).toHaveBeenCalledTimes(1);
    expect(h.runAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: A,
        triggerType: 'tag_added',
        contactId: CONTACT_A,
        context: expect.objectContaining({ tag_id: TAG_A1 }),
      })
    );

    // Y el webhook saliente de fase 7 §4, con la misma carga.
    expect(h.emitWebhookEvent).toHaveBeenCalledWith(A, 'contact.tag_added', {
      contact_id: CONTACT_A,
      tag_id: TAG_A1,
    });
  });

  it('con una etiqueta de otra cuenta responde 404 y no escribe ni dispara nada', async () => {
    const before = h.db.snapshot(B);
    const { request, ctx } = postTo(CONTACT_A, { tag_ids: [TAG_B] });
    const res = await POST(request, ctx);

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(joins()).toHaveLength(0);
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.emitWebhookEvent).not.toHaveBeenCalled();
    expect(h.db.snapshot(B)).toEqual(before);
  });

  it('una lista mixta no ata NADA: el 404 llega antes de la primera escritura', async () => {
    // Hallazgo 1 de `review_tags-v1.md`. Antes, el bucle ataba id por id:
    // con [propia, ajena] la propia quedaba puesta, su
    // `contact.tag_added` emitido, y el cliente recibía un 404 que no
    // decía qué había entrado. Ahora los ids se resuelven de una vez
    // antes de escribir, así que la respuesta y la base coinciden.
    const before = h.db.snapshot(B);
    const { request, ctx } = postTo(CONTACT_A, { tag_ids: [TAG_A1, TAG_B] });
    const res = await POST(request, ctx);

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(joins()).toHaveLength(0);
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.emitWebhookEvent).not.toHaveBeenCalled();
    expect(h.db.snapshot(B)).toEqual(before);
    // Y no hubo ni un INSERT en la unión: no es que se deshiciera, es
    // que no llegó a pasar.
    expect(
      h.db.log.filter((e) => e.table === 'contact_tags' && e.op === 'insert')
    ).toHaveLength(0);
  });

  it('un id que no existe en ninguna cuenta tampoco ata las etiquetas buenas que iban delante', async () => {
    const { request, ctx } = postTo(CONTACT_A, {
      tag_ids: [TAG_A1, TAG_A2, 'cccccccc-0000-4000-8000-000000000009'],
    });
    const res = await POST(request, ctx);

    expect(res.status).toBe(404);
    expect(joins()).toHaveLength(0);
    expect(h.emitWebhookEvent).not.toHaveBeenCalled();
  });

  it('resuelve los ids en UNA consulta acotada por cuenta, no una por id', async () => {
    const { request, ctx } = postTo(CONTACT_A, { tag_ids: [TAG_A1, TAG_A2] });
    const res = await POST(request, ctx);
    expect(res.status).toBe(200);

    // La consulta de resolución: `in` sobre los dos ids y `eq` sobre la
    // cuenta. Es lo que convierte el lote en todo-o-nada.
    const resolucion = h.db.log.filter(
      (e) =>
        e.table === 'tags' &&
        e.op === 'select' &&
        e.filters.some((f) => f.op === 'in')
    );
    expect(resolucion).toHaveLength(1);
    expect(resolucion[0].filters).toEqual(
      expect.arrayContaining([
        { column: 'account_id', op: 'eq', value: A },
        { column: 'id', op: 'in', value: [TAG_A1, TAG_A2] },
      ])
    );
  });

  it('con un contacto de otra cuenta responde 404 antes de tocar ninguna etiqueta', async () => {
    const before = h.db.snapshot(B);
    const { request, ctx } = postTo(CONTACT_B, { tag_ids: [TAG_A1] });
    const res = await POST(request, ctx);

    expect(res.status).toBe(404);
    expect(joins()).toHaveLength(0);
    expect(h.db.snapshot(B)).toEqual(before);
  });

  it('rechaza un tag_ids que no sea una lista de cadenas no vacías', async () => {
    for (const body of [
      {},
      { tag_ids: TAG_A1 },
      { tag_ids: [] },
      { tag_ids: [TAG_A1, ''] },
      { tag_ids: [TAG_A1, 7] },
    ]) {
      const { request, ctx } = postTo(CONTACT_A, body);
      const res = await POST(request, ctx);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain('tag_ids');
    }
    expect(joins()).toHaveLength(0);
  });

  it(`rechaza más de ${MAX_TAG_IDS_PER_CALL} ids en una llamada`, async () => {
    const tagIds = Array.from(
      { length: MAX_TAG_IDS_PER_CALL + 1 },
      (_, i) => `id-${i}`
    );
    const { request, ctx } = postTo(CONTACT_A, { tag_ids: tagIds });
    const res = await POST(request, ctx);
    expect(res.status).toBe(400);
    expect(joins()).toHaveLength(0);
  });

  it('exige Content-Type: application/json y respeta el tope de 1 MiB', async () => {
    const plain = await POST(
      new Request(`https://crm.test/api/v1/contacts/${CONTACT_A}/tags`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ tag_ids: [TAG_A1] }),
      }),
      { params: Promise.resolve({ id: CONTACT_A }) }
    );
    expect(plain.status).toBe(415);

    const huge = await POST(
      new Request(`https://crm.test/api/v1/contacts/${CONTACT_A}/tags`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tag_ids: [TAG_A1],
          note: 'x'.repeat(MAX_BODY_BYTES),
        }),
      }),
      { params: Promise.resolve({ id: CONTACT_A }) }
    );
    expect(huge.status).toBe(413);
    expect(joins()).toHaveLength(0);
  });
});

describe('DELETE /api/v1/contacts/{id}/tags/{tagId}', () => {
  beforeEach(() => {
    h.db.rows('contact_tags').push({
      id: 'join-1',
      contact_id: CONTACT_A,
      tag_id: TAG_A1,
    });
  });

  it('quita la etiqueta, emite contact.tag_removed y devuelve el contacto sin ella', async () => {
    const { request, ctx } = deleteFrom(CONTACT_A, TAG_A1);
    const res = await DELETE(request, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.tags).toEqual([]);
    expect(joins()).toHaveLength(0);
    expect(h.emitWebhookEvent).toHaveBeenCalledWith(A, 'contact.tag_removed', {
      contact_id: CONTACT_A,
      tag_id: TAG_A1,
    });
  });

  it('repetido sigue siendo 200 pero NO vuelve a anunciar una retirada', async () => {
    const first = await (() => {
      const { request, ctx } = deleteFrom(CONTACT_A, TAG_A1);
      return DELETE(request, ctx);
    })();
    expect(first.status).toBe(200);
    h.emitWebhookEvent.mockClear();

    // Segunda pasada: el DELETE no alcanza ninguna fila. La operación es
    // idempotente —el estado que pidió el llamante se cumple— pero no
    // hubo cambio, así que no hay evento que contar.
    const { request, ctx } = deleteFrom(CONTACT_A, TAG_A1);
    const second = await DELETE(request, ctx);
    expect(second.status).toBe(200);
    expect(h.emitWebhookEvent).not.toHaveBeenCalled();
  });

  it('una etiqueta que el contacto nunca tuvo tampoco emite nada', async () => {
    const { request, ctx } = deleteFrom(CONTACT_A, TAG_A2);
    const res = await DELETE(request, ctx);
    expect(res.status).toBe(200);
    expect(h.emitWebhookEvent).not.toHaveBeenCalled();
    // Y no se llevó por delante la que sí tenía.
    expect(joins()).toHaveLength(1);
  });

  it('con una etiqueta de otra cuenta responde 404 y no toca la unión', async () => {
    const before = h.db.snapshot(B);
    const { request, ctx } = deleteFrom(CONTACT_A, TAG_B);
    const res = await DELETE(request, ctx);

    expect(res.status).toBe(404);
    expect(joins()).toHaveLength(1);
    expect(h.emitWebhookEvent).not.toHaveBeenCalled();
    expect(h.db.snapshot(B)).toEqual(before);
  });

  it('con un contacto de otra cuenta responde 404', async () => {
    const before = h.db.snapshot(B);
    const { request, ctx } = deleteFrom(CONTACT_B, TAG_A1);
    const res = await DELETE(request, ctx);

    expect(res.status).toBe(404);
    expect(joins()).toHaveLength(1);
    expect(h.db.snapshot(B)).toEqual(before);
  });
});
