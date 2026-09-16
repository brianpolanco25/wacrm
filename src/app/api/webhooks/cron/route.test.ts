import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({}) as unknown),
  sweepDueDeliveries: vi.fn(),
  purgeOldDeliveries: vi.fn(),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

vi.mock('@/lib/webhooks/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/queue')>()),
  sweepDueDeliveries: mocks.sweepDueDeliveries,
  purgeOldDeliveries: mocks.purgeOldDeliveries,
}));

import { GET } from './route';

const EMPTY_SWEEP = {
  scanned: 0,
  attempted: 0,
  delivered: 0,
  failed: 0,
  dead: 0,
  skipped: 0,
};

function req(secret?: string) {
  return new Request('https://crm.example.com/api/webhooks/cron', {
    headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  });
}

beforeEach(() => {
  mocks.sweepDueDeliveries.mockReset().mockResolvedValue({
    ...EMPTY_SWEEP,
    scanned: 3,
    attempted: 2,
    delivered: 1,
    failed: 1,
  });
  mocks.purgeOldDeliveries.mockReset().mockResolvedValue(7);
  vi.stubEnv('WEBHOOK_CRON_SECRET', 'cron-secret');
});

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/webhooks/cron', () => {
  it('503 si WEBHOOK_CRON_SECRET no está configurado', async () => {
    vi.stubEnv('WEBHOOK_CRON_SECRET', '');
    const res = await GET(req('cron-secret'));
    expect(res.status).toBe(503);
    expect(mocks.sweepDueDeliveries).not.toHaveBeenCalled();
  });

  it('401 sin cabecera', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mocks.sweepDueDeliveries).not.toHaveBeenCalled();
  });

  it('401 con un secreto de otra longitud (sin lanzar en timingSafeEqual)', async () => {
    const res = await GET(req('x'));
    expect(res.status).toBe(401);
  });

  it('401 con un secreto de la misma longitud pero distinto', async () => {
    const res = await GET(req('cron-secreT'));
    expect(res.status).toBe(401);
    expect(mocks.sweepDueDeliveries).not.toHaveBeenCalled();
  });

  it('drena y purga con el secreto correcto', async () => {
    const res = await GET(req('cron-secret'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ...EMPTY_SWEEP,
      scanned: 3,
      attempted: 2,
      delivered: 1,
      failed: 1,
      purged: 7,
    });
    expect(mocks.sweepDueDeliveries).toHaveBeenCalledTimes(1);
    expect(mocks.purgeOldDeliveries).toHaveBeenCalledTimes(1);
  });
});
