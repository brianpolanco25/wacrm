import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  assertPlanFeature: vi.fn(),
  state: {
    inserted: null as Record<string, unknown> | null,
    filters: [] as [string, unknown][],
  },
}));

// `toErrorResponse` va sin doblar a propósito: es quien traduce el
// error de facturación a un 402 con `code`, y eso es lo que se afirma.
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertPlanFeature: mocks.assertPlanFeature,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => String(v).replace(/^enc:/, ''),
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
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
            last_delivery_at: null,
            failure_count: 0,
            created_at: '2026-09-01T00:00:00Z',
          },
          error: null,
        }),
      };
      return chain;
    },
  };
}

const ctx = () => ({
  supabase: supabaseMock(),
  accountId: 'acct-1',
  userId: 'user-1',
  role: 'admin',
});

function req(body: unknown) {
  return new Request('http://localhost/api/account/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetRateLimitForTests();
  mocks.state.inserted = null;
  mocks.state.filters = [];
  mocks.getCurrentAccount.mockReset().mockResolvedValue(ctx());
  mocks.requireRole.mockReset().mockResolvedValue(ctx());
  mocks.assertPlanFeature.mockReset().mockResolvedValue({});
});

describe('/api/account/webhooks', () => {
  it('lista acotando por cuenta, sin exigir admin', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.state.filters).toContainEqual(['account_id', 'acct-1']);
  });

  it('crea con admin, cifra el secreto y lo devuelve una vez', async () => {
    const res = await POST(
      req({
        url: 'https://hook.example.com/in',
        events: ['message.received', 'conversation.closed'],
      })
    );

    expect(res.status).toBe(201);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.assertPlanFeature).toHaveBeenCalledWith('acct-1', 'webhooks');
    expect(mocks.state.inserted?.account_id).toBe('acct-1');
    expect(String(mocks.state.inserted?.secret)).toMatch(/^enc:whsec_/);

    const body = await res.json();
    expect(body.secret).toMatch(/^whsec_/);
    // La representación pública nunca lleva el secreto guardado.
    expect(body.webhook).not.toHaveProperty('secret');
  });

  it('rechaza http:// y una lista de eventos desconocida', async () => {
    const insecure = await POST(
      req({ url: 'http://hook.example.com/in', events: ['message.received'] })
    );
    expect(insecure.status).toBe(400);

    const bogus = await POST(
      req({ url: 'https://hook.example.com/in', events: ['message.exploded'] })
    );
    expect(bogus.status).toBe(400);
    expect(mocks.state.inserted).toBeNull();
  });

  it('un plan sin webhooks no puede crear', async () => {
    const { FeatureNotAvailableError } = await import('@/lib/billing/enforce');
    mocks.assertPlanFeature.mockRejectedValue(
      new FeatureNotAvailableError('webhooks')
    );
    const res = await POST(
      req({ url: 'https://hook.example.com/in', events: ['message.received'] })
    );
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe('feature_unavailable');
    expect(mocks.state.inserted).toBeNull();
  });
});
