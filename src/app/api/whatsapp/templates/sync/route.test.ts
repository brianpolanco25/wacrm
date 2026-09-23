import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// a7.8 §4 — `POST /api/whatsapp/templates/sync` (el botón «Sincronizar» del
// panel) no tenía test propio. `syncTemplatesFromMeta` va de verdad: lo que
// se simula es Meta (`fetch`) y la tabla `message_templates`, para que el
// camino feliz recorra el algoritmo compartido con `/api/v1` y no un doble.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveWhatsAppConfig: vi.fn(),
  emit: vi.fn(),
  /** Filas de `message_templates` que ve la búsqueda previa. */
  existing: [] as Row[],
  inserted: [] as Row[],
  updated: [] as Row[],
  /** Si se fija, el INSERT devuelve este error de Postgres. */
  insertError: null as { message: string } | null,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: h.requireRole,
}));

vi.mock('@/lib/whatsapp/resolve-config', () => ({
  resolveWhatsAppConfig: h.resolveWhatsAppConfig,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => String(v).replace(/^enc:/, ''),
}));

vi.mock('@/lib/webhooks/emit', () => ({
  emitWebhookEvent: h.emit,
}));

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { POST } from './route';

const PG_LEAK =
  'duplicate key value violates unique constraint "message_templates_account_id_name_language_key"';

function fakeDb() {
  return {
    from(table: string) {
      if (table !== 'message_templates') {
        throw new Error(`unexpected table ${table}`);
      }
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        maybeSingle: async () => ({
          data:
            h.existing.find((r) =>
              Object.entries(filters).every(([k, v]) => r[k] === v)
            ) ?? null,
          error: null,
        }),
        insert: async (row: Row) => {
          if (h.insertError) return { error: h.insertError };
          h.inserted.push(row);
          return { error: null };
        },
        update: (row: Row) => {
          h.updated.push(row);
          return {
            eq: () => ({ eq: async () => ({ error: null }) }),
          };
        },
      };
      return chain;
    },
  };
}

const META_TEMPLATES = [
  {
    id: 'meta-1',
    name: 'bienvenida',
    language: 'es',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{1}}' }],
  },
  {
    id: 'meta-2',
    name: 'promo',
    language: 'es',
    status: 'PENDING',
    category: 'MARKETING',
    components: [{ type: 'BODY', text: 'Oferta' }],
  },
];

const fetchMock = vi.fn();

beforeEach(() => {
  h.existing = [
    {
      id: 'tpl-1',
      account_id: 'acct-1',
      name: 'promo',
      language: 'es',
      status: 'PENDING',
    },
  ];
  h.inserted = [];
  h.updated = [];
  h.insertError = null;
  h.emit.mockReset().mockResolvedValue(undefined);
  h.requireRole.mockReset().mockResolvedValue({
    supabase: fakeDb(),
    accountId: 'acct-1',
    userId: 'user-1',
  });
  h.resolveWhatsAppConfig.mockReset().mockResolvedValue({
    row: { waba_id: 'waba-1', access_token: 'enc:tok-1' },
  });
  fetchMock
    .mockReset()
    .mockResolvedValue(
      Response.json({ data: META_TEMPLATES, paging: {} }, { status: 200 })
    );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/whatsapp/templates/sync', () => {
  it('401 sin sesión, sin llamar a Meta', async () => {
    h.requireRole.mockRejectedValue(new UnauthorizedError());
    const res = await POST();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('403 por debajo de admin, sin llamar a Meta', async () => {
    h.requireRole.mockRejectedValue(new ForbiddenError());
    const res = await POST();
    expect(res.status).toBe(403);
    expect(h.requireRole).toHaveBeenCalledWith('admin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sincroniza con Meta simulada: inserta la nueva y actualiza la existente', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      total: 2,
      inserted: 1,
      updated: 1,
      errors: [],
      truncated: false,
    });

    // La WABA y el token descifrado del número resuelto.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/waba-1/message_templates');
    expect(init.headers.Authorization).toBe('Bearer tok-1');

    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      name: 'bienvenida',
      category: 'Utility',
    });
    expect(h.updated).toHaveLength(1);
  });

  it('un error de Postgres por plantilla no llega al navegador', async () => {
    h.existing = [];
    h.insertError = { message: PG_LEAK };

    const res = await POST();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('message_templates_account_id');
    expect(text).not.toContain('duplicate key');

    const json = JSON.parse(text);
    expect(json.success).toBe(false);
    // Lo accionable sí: qué plantillas no se guardaron.
    expect(json.errors).toEqual([
      {
        name: 'bienvenida',
        language: 'es',
        message: 'Template could not be saved',
      },
      { name: 'promo', language: 'es', message: 'Template could not be saved' },
    ]);
    // El detalle queda en el log del servidor.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('bienvenida/es'),
      PG_LEAK
    );
  });

  it('un error inesperado responde 500 con texto fijo, sin su mensaje', async () => {
    h.requireRole.mockResolvedValue({
      supabase: {
        from: () => {
          throw new Error(PG_LEAK);
        },
      },
      accountId: 'acct-1',
      userId: 'user-1',
    });

    const res = await POST();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to sync templates' });
  });

  it('Meta rechaza el catálogo: 502 con el mensaje de Meta', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { message: 'Invalid OAuth access token' } },
        { status: 401 }
      )
    );
    const res = await POST();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Invalid OAuth access token');
    expect(h.inserted).toHaveLength(0);
  });

  it('400 si la cuenta no tiene WhatsApp configurado', async () => {
    h.resolveWhatsAppConfig.mockRejectedValue(new Error('not configured'));
    const res = await POST();
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
