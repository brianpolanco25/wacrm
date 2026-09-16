import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  assertPlanFeature: vi.fn(),
  supabaseAdmin: vi.fn(() => ({ name: 'service-role' })),
  sendTestDelivery: vi.fn(),
  retryDelivery: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertPlanFeature: mocks.assertPlanFeature,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

vi.mock('@/lib/webhooks/manage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/manage')>()),
  sendTestDelivery: mocks.sendTestDelivery,
  retryDelivery: mocks.retryDelivery,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST as TEST } from './route';
import { POST as RETRY } from '../deliveries/[deliveryId]/retry/route';

const params = { params: Promise.resolve({ id: 'wh-1' }) };
const retryParams = {
  params: Promise.resolve({ id: 'wh-1', deliveryId: 'd-1' }),
};

const request = () => new Request('http://localhost', { method: 'POST' });

beforeEach(() => {
  __resetRateLimitForTests();
  mocks.requireRole.mockReset().mockResolvedValue({
    supabase: { name: 'rls-client' },
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
  });
  mocks.assertPlanFeature.mockReset().mockResolvedValue({});
  mocks.sendTestDelivery
    .mockReset()
    .mockResolvedValue({ status: 'delivered', delivery: { id: 'd-ping' } });
  mocks.retryDelivery.mockReset().mockResolvedValue({
    kind: 'attempted',
    status: 'delivered',
    delivery: { id: 'd-1' },
  });
});

describe('POST /api/account/webhooks/[id]/test', () => {
  it('exige admin y usa el rol de servicio acotado por la cuenta de la sesión', async () => {
    const res = await TEST(request(), params);
    expect(res.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.sendTestDelivery).toHaveBeenCalledWith(
      { name: 'service-role' },
      'acct-1',
      'wh-1'
    );
  });

  it('404 con un endpoint ajeno', async () => {
    mocks.sendTestDelivery.mockResolvedValue(null);
    expect((await TEST(request(), params)).status).toBe(404);
  });
});

describe('POST /api/account/webhooks/[id]/deliveries/[deliveryId]/retry', () => {
  it('reintenta con el rol de servicio y la cuenta de la sesión', async () => {
    const res = await RETRY(request(), retryParams);
    expect(res.status).toBe(200);
    expect(mocks.retryDelivery).toHaveBeenCalledWith(
      { name: 'service-role' },
      'acct-1',
      'wh-1',
      'd-1'
    );
  });

  it('409 si ya estaba en cola y 404 si no es de la cuenta', async () => {
    mocks.retryDelivery.mockResolvedValue({
      kind: 'already_queued',
      delivery: { id: 'd-1' },
    });
    expect((await RETRY(request(), retryParams)).status).toBe(409);

    mocks.retryDelivery.mockResolvedValue({ kind: 'not_found' });
    expect((await RETRY(request(), retryParams)).status).toBe(404);
  });

  it('el cubo por cuenta corta la ráfaga', async () => {
    for (let i = 0; i < 20; i++) await RETRY(request(), retryParams);
    expect((await RETRY(request(), retryParams)).status).toBe(429);
  });
});
