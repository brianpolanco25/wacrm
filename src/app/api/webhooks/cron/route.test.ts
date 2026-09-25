import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({}) as unknown),
  sweepDueDeliveries: vi.fn(),
  purgeOldDeliveries: vi.fn(),
  sweepExportJobs: vi.fn(),
  purgeExpiredExports: vi.fn(),
  renewExpiringTokens: vi.fn(),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

vi.mock('@/lib/webhooks/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/queue')>()),
  sweepDueDeliveries: mocks.sweepDueDeliveries,
  purgeOldDeliveries: mocks.purgeOldDeliveries,
}));

// Fase 7 §5: el mismo barrido retoma y purga las exportaciones, con su
// propio cupo.
vi.mock('@/lib/exports/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exports/jobs')>()),
  sweepExportJobs: mocks.sweepExportJobs,
  purgeExpiredExports: mocks.purgeExpiredExports,
}));

// Migración 067: el mismo barrido renueva los tokens de Embedded Signup.
vi.mock('@/lib/whatsapp/token-renewal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/token-renewal')>()),
  renewExpiringTokens: mocks.renewExpiringTokens,
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

const EMPTY_EXPORT_SWEEP = {
  scanned: 0,
  processed: 0,
  done: 0,
  failed: 0,
  skipped: 0,
};

const TOKEN_SWEEP = {
  enabled: true,
  scanned: 1,
  renewed: 1,
  failed: 0,
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
  mocks.sweepExportJobs.mockReset().mockResolvedValue({
    ...EMPTY_EXPORT_SWEEP,
    scanned: 1,
    processed: 1,
    done: 1,
  });
  mocks.purgeExpiredExports.mockReset().mockResolvedValue(2);
  mocks.renewExpiringTokens.mockReset().mockResolvedValue(TOKEN_SWEEP);
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
      exports: {
        ...EMPTY_EXPORT_SWEEP,
        scanned: 1,
        processed: 1,
        done: 1,
        purged: 2,
      },
      tokens: TOKEN_SWEEP,
    });
    expect(mocks.sweepDueDeliveries).toHaveBeenCalledTimes(1);
    expect(mocks.purgeOldDeliveries).toHaveBeenCalledTimes(1);
    expect(mocks.sweepExportJobs).toHaveBeenCalledTimes(1);
    expect(mocks.purgeExpiredExports).toHaveBeenCalledTimes(1);
    expect(mocks.renewExpiringTokens).toHaveBeenCalledTimes(1);
  });

  it('no renueva tokens sin el secreto', async () => {
    await GET(req());
    expect(mocks.renewExpiringTokens).not.toHaveBeenCalled();
  });

  it('las entregas no dependen de las exportaciones: el bloque exports es aditivo', async () => {
    // Fase 7 §5. Lo que a7.4 devolvía sigue en la raíz del objeto, de
    // modo que un programador que solo leía `delivered` no se entera de
    // que ahora también se barren exportaciones.
    const res = await GET(req('cron-secret'));
    const body = await res.json();
    expect(body.delivered).toBe(1);
    expect(body.purged).toBe(7);
    expect(body.exports.purged).toBe(2);
    expect(body.tokens.renewed).toBe(1);
  });
});
