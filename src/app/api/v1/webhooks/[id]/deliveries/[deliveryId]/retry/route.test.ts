import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  assertPlanFeature: vi.fn(),
  retryDelivery: vi.fn(),
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
  retryDelivery: mocks.retryDelivery,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const params = {
  params: Promise.resolve({ id: 'wh-1', deliveryId: 'd-1' }),
};

function req() {
  return new Request(
    'https://crm.example.com/api/v1/webhooks/wh-1/deliveries/d-1/retry',
    { method: 'POST', headers: { authorization: 'Bearer wacrm_live_x' } }
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  mocks.requireApiKey.mockReset().mockResolvedValue({
    authType: 'api_key',
    supabase: { name: 'service-role' },
    accountId: 'acct-1',
    keyId: 'key-1',
    scopes: ['webhooks:manage'],
    createdBy: 'user-1',
  });
  mocks.assertPlanFeature.mockReset().mockResolvedValue({});
  mocks.retryDelivery.mockReset().mockResolvedValue({
    kind: 'attempted',
    status: 'delivered',
    delivery: { id: 'd-1', status: 'delivered' },
  });
});

describe('POST /api/v1/webhooks/[id]/deliveries/[deliveryId]/retry', () => {
  it('reintenta acotando por cuenta y devuelve el resultado', async () => {
    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(mocks.retryDelivery).toHaveBeenCalledWith(
      { name: 'service-role' },
      'acct-1',
      'wh-1',
      'd-1'
    );
    await expect(res.json()).resolves.toEqual({
      data: { id: 'd-1', status: 'delivered', result: 'delivered' },
    });
  });

  it('404 cuando la entrega no es de la cuenta', async () => {
    mocks.retryDelivery.mockResolvedValue({ kind: 'not_found' });
    const res = await POST(req(), params);
    expect(res.status).toBe(404);
  });

  it('409 cuando ya estaba en cola', async () => {
    mocks.retryDelivery.mockResolvedValue({
      kind: 'already_queued',
      delivery: { id: 'd-1' },
    });
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('conflict');
  });

  it('agotado el cubo por cuenta, 429 con Retry-After', async () => {
    for (let i = 0; i < 20; i++) await POST(req(), params);
    const res = await POST(req(), params);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });
});
