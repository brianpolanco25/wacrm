import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  assertPlanFeature: vi.fn(),
  listDeliveries: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertPlanFeature: mocks.assertPlanFeature,
}));

vi.mock('@/lib/webhooks/manage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/manage')>()),
  listDeliveries: mocks.listDeliveries,
}));

import { GET } from './route';

const params = { params: Promise.resolve({ id: 'wh-1' }) };

function req(query = '') {
  return new Request(
    `https://crm.example.com/api/v1/webhooks/wh-1/deliveries${query}`,
    { headers: { authorization: 'Bearer wacrm_live_x' } }
  );
}

beforeEach(() => {
  mocks.requireApiKey.mockReset().mockResolvedValue({
    authType: 'api_key',
    supabase: { name: 'service-role' },
    accountId: 'acct-1',
    keyId: 'key-1',
    scopes: ['webhooks:manage'],
    createdBy: 'user-1',
  });
  mocks.assertPlanFeature.mockReset().mockResolvedValue({});
  mocks.listDeliveries
    .mockReset()
    .mockResolvedValue({ items: [{ id: 'd-1' }], nextCursor: null });
});

describe('GET /api/v1/webhooks/[id]/deliveries', () => {
  it('exige el scope y la funcionalidad de plan, y acota por cuenta', async () => {
    const res = await GET(req(), params);

    expect(res.status).toBe(200);
    expect(mocks.requireApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'webhooks:manage'
    );
    expect(mocks.assertPlanFeature).toHaveBeenCalledWith('acct-1', 'webhooks');
    expect(mocks.listDeliveries).toHaveBeenCalledWith(
      { name: 'service-role' },
      'acct-1',
      'wh-1',
      expect.objectContaining({ limit: 50, cursor: null })
    );
    await expect(res.json()).resolves.toEqual({
      data: [{ id: 'd-1' }],
      meta: { next_cursor: null },
    });
  });

  it('pasa el filtro de estado y rechaza uno inventado', async () => {
    await GET(req('?status=dead'), params);
    expect(mocks.listDeliveries).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'wh-1',
      expect.objectContaining({ status: 'dead' })
    );

    const bad = await GET(req('?status=retrying'), params);
    expect(bad.status).toBe(400);
    expect(mocks.listDeliveries).toHaveBeenCalledTimes(1);
  });

  it('404 cuando el endpoint no es de la cuenta', async () => {
    mocks.listDeliveries.mockResolvedValue(null);
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });
});
