import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  assertPlanFeature: vi.fn(),
  sendTestDelivery: vi.fn(),
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
  sendTestDelivery: mocks.sendTestDelivery,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const params = { params: Promise.resolve({ id: 'wh-1' }) };

function req() {
  return new Request('https://crm.example.com/api/v1/webhooks/wh-1/test', {
    method: 'POST',
    headers: { authorization: 'Bearer wacrm_live_x' },
  });
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
  mocks.sendTestDelivery.mockReset().mockResolvedValue({
    status: 'delivered',
    delivery: { id: 'd-ping', event: 'ping' },
  });
});

describe('POST /api/v1/webhooks/[id]/test', () => {
  it('manda el ping acotando por cuenta', async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(mocks.sendTestDelivery).toHaveBeenCalledWith(
      { name: 'service-role' },
      'acct-1',
      'wh-1'
    );
    await expect(res.json()).resolves.toEqual({
      data: { id: 'd-ping', event: 'ping', result: 'delivered' },
    });
  });

  it('404 con un endpoint ajeno', async () => {
    mocks.sendTestDelivery.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(404);
  });

  it('el cubo por cuenta corta la ráfaga', async () => {
    for (let i = 0; i < 20; i++) await POST(req(), params);
    expect((await POST(req(), params)).status).toBe(429);
  });
});
