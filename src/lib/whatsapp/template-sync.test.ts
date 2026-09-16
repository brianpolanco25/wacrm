import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// Fase 7 §3 — la sincronización del catálogo, ya fuera de la ruta del panel.
//
// Este archivo existe por una razón concreta: el algoritmo se MOVIÓ de
// `src/app/api/whatsapp/templates/sync/route.ts` a `template-sync.ts` para
// que `POST /api/v1/templates/sync` no lo duplique, y un refactor así se
// paga con la posibilidad de haber cambiado el comportamiento del panel sin
// enterarse. Lo que se fija aquí es justo lo que no puede cambiar: cómo se
// pagina, qué se inserta y qué se actualiza, cuándo sale
// `template.status_updated`, y que ningún error de una plantilla suelta
// tumbe el resto.
//
// La base es `fake-supabase.ts`, que evalúa las consultas de verdad y está
// sembrada con DOS cuentas cuya plantilla comparte (name, language): si a
// una consulta se le cae el `.eq('account_id', …)`, casa con la fila de la
// otra cuenta y el test lo ve.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  emitted: [] as { accountId: string; event: string; data: unknown }[],
}));

vi.mock('@/lib/webhooks/emit', () => ({
  emitWebhookEvent: async (accountId: string, event: string, data: unknown) => {
    h.emitted.push({ accountId, event, data });
  },
}));

import {
  syncTemplatesFromMeta,
  SYNC_PAGE_CAP,
  TemplateSyncError,
} from './template-sync';

// Lo justo de `Response` que lee el código bajo prueba. Dar tipo al doble
// de `fetch` no es ceremonia: es lo que hace que `mock.calls[0]` tenga la
// URL y el `init` tipados, y por tanto que las aserciones sobre lo que se
// le mandó a Meta se comprueben en vez de colarse por `any`.
type MetaResponse = Pick<Response, 'ok' | 'status' | 'json'>;
type FetchLike = (url: string, init?: RequestInit) => Promise<MetaResponse>;

const A = 'acct-a';
const B = 'acct-b';
const USER_A = 'user-a';

function seed(): FakeDatabase {
  return new FakeDatabase({
    message_templates: [
      // B primero y con el MISMO (name, language) que A: una consulta sin
      // acotar cae aquí.
      {
        id: 'tpl-b',
        account_id: B,
        user_id: 'user-b',
        name: 'promo',
        language: 'en_US',
        status: 'APPROVED',
        category: 'Marketing',
        body_text: 'Hi {{1}} from B',
        meta_template_id: 'meta-b',
      },
      {
        id: 'tpl-a',
        account_id: A,
        user_id: USER_A,
        name: 'promo',
        language: 'en_US',
        status: 'PENDING',
        category: 'Marketing',
        body_text: 'Hi {{1}} from A',
        meta_template_id: 'meta-a',
      },
    ],
  });
}

/** Una plantilla como la devuelve la Graph API. */
function metaTemplate(over: Record<string, unknown> = {}) {
  return {
    id: 'meta-a',
    name: 'promo',
    language: 'en_US',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}',
        example: { body_text: [['Ada']] },
      },
    ],
    ...over,
  };
}

/** Encola respuestas de Meta, una por página. */
function metaPages(...pages: unknown[]) {
  const fetchMock = vi.fn<FetchLike>(async () => {
    const page = pages.shift() ?? { data: [] };
    return {
      ok: true,
      status: 200,
      json: async () => page,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** El cliente de rol de servicio, con el tipo que espera la función. */
const admin = (d: FakeDatabase) => d.admin as unknown as SupabaseClient;

const ARGS = {
  accountId: A,
  userId: USER_A,
  wabaId: 'waba-a',
  accessToken: 'token-a',
};

beforeEach(() => {
  h.emitted = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('syncTemplatesFromMeta', () => {
  it('sigue `paging.next` hasta agotarlo y cuenta altas y bajas por separado', async () => {
    const db = seed();
    const fetchMock = metaPages(
      {
        data: [metaTemplate()],
        paging: { next: 'https://graph.facebook.com/v21.0/next-page' },
      },
      { data: [metaTemplate({ id: 'meta-new', name: 'welcome' })] }
    );

    const result = await syncTemplatesFromMeta(admin(db), ARGS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // La segunda llamada usa la URL que dio Meta, no una reconstruida.
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://graph.facebook.com/v21.0/next-page'
    );
    expect(result).toMatchObject({
      total: 2,
      inserted: 1,
      updated: 1,
      errors: [],
      truncated: false,
    });
  });

  it('actualiza la fila de la cuenta, no la homónima de la otra', async () => {
    const db = seed();
    const before = db.snapshot(B);
    metaPages({ data: [metaTemplate()] });

    await syncTemplatesFromMeta(admin(db), ARGS);

    const rows = db.rows('message_templates') as Row[];
    expect(rows.find((r) => r.id === 'tpl-a')).toMatchObject({
      status: 'APPROVED',
      body_text: 'Hi {{1}}',
      sample_values: { body: ['Ada'] },
    });
    expect(db.snapshot(B)).toEqual(before);
  });

  it('emite `template.status_updated` solo cuando Meta movió la revisión', async () => {
    const db = seed();
    // `promo` ya estaba PENDING y pasa a APPROVED; `stable` entra nueva
    // (un alta no es un cambio de estado: nadie estaba esperándolo).
    metaPages({
      data: [metaTemplate(), metaTemplate({ id: 'meta-s', name: 'stable' })],
    });

    const first = await syncTemplatesFromMeta(admin(db), ARGS);

    expect(first.statusChanges).toEqual([
      {
        template_id: 'tpl-a',
        name: 'promo',
        language: 'en_US',
        status: 'APPROVED',
        previous_status: 'PENDING',
      },
    ]);
    expect(h.emitted).toEqual([
      {
        accountId: A,
        event: 'template.status_updated',
        data: first.statusChanges[0],
      },
    ]);

    // Segunda pasada idéntica: Meta no movió nada, así que no se emite
    // nada. Es la diferencia entre un webhook útil y un latido por minuto.
    h.emitted = [];
    metaPages({
      data: [metaTemplate(), metaTemplate({ id: 'meta-s', name: 'stable' })],
    });
    const second = await syncTemplatesFromMeta(admin(db), ARGS);
    expect(second.statusChanges).toEqual([]);
    expect(h.emitted).toEqual([]);
    expect(second.updated).toBe(2);
  });

  it('normaliza categoría, calidad y cabecera como lo hacía la ruta del panel', async () => {
    const db = seed();
    metaPages({
      data: [
        metaTemplate({
          id: 'meta-new',
          name: 'invoice',
          category: 'UTILITY',
          quality_score: { score: 'green' },
          components: [
            {
              type: 'HEADER',
              format: 'IMAGE',
              example: { header_handle: ['HANDLE-9'] },
            },
            { type: 'BODY', text: 'Your invoice {{1}}' },
            { type: 'FOOTER', text: 'Thanks' },
            {
              type: 'BUTTONS',
              buttons: [
                { type: 'QUICK_REPLY', text: 'Ok' },
                { type: 'URL', text: 'Open', url: 'https://x.test' },
                // Fuera del alcance de v1: se descarta sin romper.
                { type: 'FLOW', text: 'Flow' },
              ],
            },
          ],
        }),
      ],
    });

    await syncTemplatesFromMeta(admin(db), ARGS);

    const row = (db.rows('message_templates') as Row[]).find(
      (r) => r.name === 'invoice'
    )!;
    expect(row).toMatchObject({
      account_id: A,
      user_id: USER_A,
      category: 'Utility',
      quality_score: 'GREEN',
      header_type: 'image',
      header_handle: 'HANDLE-9',
      footer_text: 'Thanks',
      meta_template_id: 'meta-new',
    });
    expect(row.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Ok' },
      { type: 'URL', text: 'Open', url: 'https://x.test', example: undefined },
    ]);
  });

  it('un error de Meta aborta con su mensaje público y 502', async () => {
    const db = seed();
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchLike>(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: 'Invalid OAuth access token', code: 190 },
        }),
      }))
    );

    await expect(syncTemplatesFromMeta(admin(db), ARGS)).rejects.toThrow(
      TemplateSyncError
    );
    await expect(syncTemplatesFromMeta(admin(db), ARGS)).rejects.toMatchObject({
      message: 'Invalid OAuth access token',
      status: 502,
    });
    // Nada se escribió: el catálogo local queda como estaba.
    expect((db.rows('message_templates') as Row[]).length).toBe(2);
  });

  it(`marca \`truncated\` cuando Meta sigue teniendo páginas tras ${SYNC_PAGE_CAP}`, async () => {
    const db = seed();
    const fetchMock = vi.fn<FetchLike>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [],
        paging: { next: 'https://graph.facebook.com/v21.0/forever' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncTemplatesFromMeta(admin(db), ARGS);

    expect(fetchMock).toHaveBeenCalledTimes(SYNC_PAGE_CAP);
    expect(result.truncated).toBe(true);
  });

  it('un fallo al escribir una plantilla no tumba las demás', async () => {
    const db = seed();
    metaPages({
      data: [
        metaTemplate({ id: 'meta-x', name: 'boom' }),
        metaTemplate({ id: 'meta-y', name: 'fine' }),
      ],
    });

    // Un INSERT que falla solo para `boom`, envolviendo el cliente real.
    const real = db.admin;
    const client = {
      from(table: string) {
        const q = real.from(table);
        const originalInsert = q.insert.bind(q);
        q.insert = (rows: Row | Row[]) => {
          const first = Array.isArray(rows) ? rows[0] : rows;
          if (first?.name === 'boom') {
            return {
              then: (resolve: (r: unknown) => unknown) =>
                Promise.resolve(
                  resolve({ data: null, error: { message: 'insert exploded' } })
                ),
            } as never;
          }
          return originalInsert(rows);
        };
        return q;
      },
    };

    const result = await syncTemplatesFromMeta(
      client as unknown as SupabaseClient,
      ARGS
    );

    expect(result.errors).toEqual([
      { name: 'boom', language: 'en_US', message: 'insert exploded' },
    ]);
    expect(result.inserted).toBe(1);
    expect(
      (db.rows('message_templates') as Row[]).map((r) => r.name)
    ).toContain('fine');
  });
});
