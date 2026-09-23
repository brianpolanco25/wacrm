import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// a7.8 §3 — `PATCH /api/v1/webhooks/{id}` lee su cuerpo con `readJsonBody`
// desde la fase 7 §1, pero no tenía prueba propia de las guardas.
//
// Como en `../route.test.ts`, lo que se afirma no es solo el código de
// estado: un 413 o un 415 que llegase tras el UPDATE pasaría un test que solo
// mirase el número. Por eso cada caso comprueba que la ruta no escribió.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  state: {
    updates: [] as Record<string, unknown>[],
    filters: [] as [string, unknown][],
  },
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

import { MAX_BODY_BYTES } from '@/lib/api/v1/body';
import { PATCH } from './route';

const ROW = {
  id: 'wh-1',
  url: 'https://hook.example.com/in',
  events: ['message.received'],
  is_active: false,
  last_delivery_at: null,
  failure_count: 0,
  created_at: '2026-09-01T00:00:00Z',
};

function supabaseMock() {
  return {
    from: (table: string) => {
      if (table !== 'webhook_endpoints') {
        throw new Error(`unexpected table ${table}`);
      }
      let patch: Record<string, unknown> | null = null;
      const chain = {
        update: (row: Record<string, unknown>) => {
          patch = row;
          mocks.state.updates.push(row);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          mocks.state.filters.push([col, val]);
          return chain;
        },
        select: () => chain,
        maybeSingle: async () => ({
          data: patch ? { ...ROW, ...patch } : null,
          error: null,
        }),
      };
      return chain;
    },
  };
}

const params = { params: Promise.resolve({ id: 'wh-1' }) };

function patch(body: string, contentType: string | null) {
  const headers: Record<string, string> = {
    authorization: 'Bearer wacrm_live_x',
  };
  if (contentType) headers['content-type'] = contentType;
  return new Request('https://crm.example.com/api/v1/webhooks/wh-1', {
    method: 'PATCH',
    headers,
    body,
  });
}

beforeEach(() => {
  mocks.state.updates = [];
  mocks.state.filters = [];
  mocks.requireApiKey.mockReset().mockResolvedValue({
    authType: 'api_key',
    supabase: supabaseMock(),
    accountId: 'acct-1',
    keyId: 'key-1',
    scopes: ['webhooks:manage'],
    createdBy: 'user-1',
  });
});

describe('PATCH /api/v1/webhooks/[id] — guardas de cuerpo', () => {
  it('rechaza un cuerpo de 1 MiB + 1 con 413 y no actualiza nada', async () => {
    // Bytes de verdad, no un Content-Length falseado.
    const body = JSON.stringify({
      is_active: true,
      padding: 'x'.repeat(MAX_BODY_BYTES),
    });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(MAX_BODY_BYTES);

    const res = await PATCH(patch(body, 'application/json'), params);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('payload_too_large');
    expect(mocks.state.updates).toHaveLength(0);
  });

  it('rechaza text/plain con 415, y la falta de Content-Type también', async () => {
    const body = JSON.stringify({ is_active: true });

    const plain = await PATCH(patch(body, 'text/plain'), params);
    expect(plain.status).toBe(415);
    expect((await plain.json()).error.code).toBe('unsupported_media_type');

    const bare = await PATCH(patch(body, null), params);
    expect(bare.status).toBe(415);

    expect(mocks.state.updates).toHaveLength(0);
  });

  it('camino feliz: un PATCH mínimo actualiza acotando por cuenta', async () => {
    const res = await PATCH(
      patch(JSON.stringify({ is_active: true }), 'application/json'),
      params
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ id: 'wh-1', is_active: true });
    // Reactivar limpia la racha de fallos (ver la ruta).
    expect(mocks.state.updates).toEqual([
      { is_active: true, failure_count: 0 },
    ]);
    expect(mocks.state.filters).toEqual([
      ['id', 'wh-1'],
      ['account_id', 'acct-1'],
    ]);
    expect(mocks.requireApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      'webhooks:manage'
    );
  });
});
