import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 — outbound webhooks are their own plan feature, on top of
// the `api` feature that `requireApiKey` already checks.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  assertPlanFeature: vi.fn(),
  state: {
    inserted: null as Record<string, unknown> | null,
    filters: [] as [string, unknown][],
  },
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertPlanFeature: mocks.assertPlanFeature,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => String(v).replace(/^enc:/, ''),
}));

import { FeatureNotAvailableError } from '@/lib/billing/enforce';
import { MAX_BODY_BYTES } from '@/lib/api/v1/body';
import { GET, POST } from './route';

function supabaseMock() {
  return {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          mocks.state.filters.push([col, val]);
          return chain;
        },
        order: () => Promise.resolve({ data: [], error: null }),
        insert: (row: Record<string, unknown>) => {
          mocks.state.inserted = row;
          return chain;
        },
        single: async () => ({
          data: {
            id: 'wh-1',
            url: 'https://hook.example.com/in',
            events: ['message.received'],
            is_active: true,
            created_at: '2026-09-01T00:00:00Z',
          },
          error: null,
        }),
      };
      return chain;
    },
  };
}

function req(method: string, body?: unknown) {
  return new Request('https://crm.example.com/api/v1/webhooks', {
    method,
    headers: {
      authorization: 'Bearer wacrm_live_x',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Igual que `req('POST', …)` pero sin decidir por el llamante ni el
 * `Content-Type` ni la serialización: estas dos pruebas van justo sobre
 * esas dos cosas.
 */
function rawPost(body: string, contentType: string | null) {
  const headers: Record<string, string> = {
    authorization: 'Bearer wacrm_live_x',
  };
  if (contentType) headers['content-type'] = contentType;
  return new Request('https://crm.example.com/api/v1/webhooks', {
    method: 'POST',
    headers,
    body,
  });
}

const NEW_HOOK = {
  url: 'https://hook.example.com/in',
  events: ['message.received'],
};

beforeEach(() => {
  mocks.state.inserted = null;
  mocks.state.filters = [];
  mocks.requireApiKey.mockReset();
  mocks.requireApiKey.mockResolvedValue({
    authType: 'api_key',
    supabase: supabaseMock(),
    accountId: 'acct-1',
    keyId: 'key-1',
    scopes: ['webhooks:manage'],
    createdBy: 'user-1',
  });
  mocks.assertPlanFeature.mockReset();
  mocks.assertPlanFeature.mockResolvedValue({
    planId: 'pro',
    status: 'active',
    limits: {},
    features: ['api', 'webhooks'],
    readOnly: false,
    trialEndsAt: null,
  });
});

describe('/api/v1/webhooks — the webhooks feature (fase 3 §4)', () => {
  it('checks the feature for the key account before listing', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(mocks.assertPlanFeature).toHaveBeenCalledWith('acct-1', 'webhooks');
  });

  it('402s a list when the plan does not include webhooks', async () => {
    mocks.assertPlanFeature.mockRejectedValue(
      new FeatureNotAvailableError('webhooks')
    );
    const res = await GET(req('GET'));
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.error.code).toBe('feature_unavailable');
    expect(json.error.feature).toBe('webhooks');
    expect(json.error.upgradeUrl).toBe('/billing');
  });

  it('402s a registration and writes nothing', async () => {
    mocks.assertPlanFeature.mockRejectedValue(
      new FeatureNotAvailableError('webhooks')
    );
    const res = await POST(req('POST', NEW_HOOK));
    expect(res.status).toBe(402);
    expect(mocks.state.inserted).toBeNull();
  });

  it('registers the endpoint when the plan includes webhooks', async () => {
    const res = await POST(req('POST', NEW_HOOK));
    expect(res.status).toBe(201);
    expect(mocks.state.inserted).toMatchObject({ account_id: 'acct-1' });
  });

  it('asks about the key account, never one from the request', async () => {
    mocks.requireApiKey.mockResolvedValue({
      authType: 'api_key',
      supabase: supabaseMock(),
      accountId: 'acct-other',
      keyId: 'key-2',
      scopes: ['webhooks:manage'],
      createdBy: 'user-2',
    });
    await POST(req('POST', { ...NEW_HOOK, account_id: 'acct-1' }));
    expect(mocks.assertPlanFeature).toHaveBeenCalledWith(
      'acct-other',
      'webhooks'
    );
    expect(mocks.state.inserted).toMatchObject({ account_id: 'acct-other' });
  });
});

// ---------------------------------------------------------------------------
// Fase 7 §1 / integración — la deuda que dejó la 2.ª ronda de a7.1: esta ruta
// pasó a `readJsonBody` sin test propio para no chocar con a7.4, y el sitio
// del test era este archivo *después* del merge. Ya estamos después.
//
// Lo que se afirma no es el código de estado, que lo daría cualquier guarda
// mal puesta, sino que la ruta no llega a insertar: un 413 respondido tras
// bufferizar el cuerpo entero, o un 415 respondido tras escribir, pasarían un
// test que solo mirase el número.
// ---------------------------------------------------------------------------
describe('POST /api/v1/webhooks — guardas de cuerpo compartidas', () => {
  it('rechaza un cuerpo de 1 MiB + 1 con 413 y no registra nada', async () => {
    // Bytes de verdad, no un Content-Length falseado: el tope tiene que
    // aguantar mientras se lee el flujo.
    const body = JSON.stringify({
      ...NEW_HOOK,
      description: 'x'.repeat(MAX_BODY_BYTES),
    });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(MAX_BODY_BYTES);

    const res = await POST(rawPost(body, 'application/json'));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('payload_too_large');
    expect(mocks.state.inserted).toBeNull();
  });

  it('rechaza text/plain con 415, y la falta de Content-Type también', async () => {
    const plain = await POST(rawPost(JSON.stringify(NEW_HOOK), 'text/plain'));
    expect(plain.status).toBe(415);
    expect((await plain.json()).error.code).toBe('unsupported_media_type');
    expect(mocks.state.inserted).toBeNull();

    const bare = await POST(rawPost(JSON.stringify(NEW_HOOK), null));
    expect(bare.status).toBe(415);
    expect(mocks.state.inserted).toBeNull();
  });
});
