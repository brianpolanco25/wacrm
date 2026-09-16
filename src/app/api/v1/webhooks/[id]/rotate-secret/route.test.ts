import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  assertPlanFeature: vi.fn(),
  rotateWebhookSecret: vi.fn(),
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
  rotateWebhookSecret: mocks.rotateWebhookSecret,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const params = { params: Promise.resolve({ id: 'wh-1' }) };

function req() {
  return new Request(
    'https://crm.example.com/api/v1/webhooks/wh-1/rotate-secret',
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
  mocks.rotateWebhookSecret.mockReset().mockResolvedValue({
    endpoint: { id: 'wh-1', url: 'https://a.example.com/hook' },
    secret: 'whsec_nuevo',
  });
});

describe('POST /api/v1/webhooks/[id]/rotate-secret', () => {
  it('devuelve el secreto nuevo una vez', async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.secret).toBe('whsec_nuevo');
    expect(mocks.rotateWebhookSecret).toHaveBeenCalledWith(
      { name: 'service-role' },
      'acct-1',
      'wh-1'
    );
  });

  it('404 con un endpoint de otra cuenta', async () => {
    mocks.rotateWebhookSecret.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(404);
  });
});
