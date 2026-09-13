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
