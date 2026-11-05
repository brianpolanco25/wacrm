import { beforeEach, describe, expect, it } from 'vitest';

import { __resetRateLimitForTests } from '@/lib/rate-limit';

import { performIntegrationRequest } from '../http';
import {
  authHeader,
  buildIntegrationRequest,
  validateCallParams,
  withAuthHeader,
} from '../request';
import { CABBITY_HEALTH_CATALOG } from './cabbity-health';

// n13.5 (R23): solo lecturas contra el servicio real de Cabbity Health.
// Se salta sin CABBITY_HEALTH_KEY (CI y compuerta). La clave se lee solo
// del entorno y nunca se imprime ni entra en un mensaje de aserción.
//
//   read -rs CABBITY_HEALTH_KEY && export CABBITY_HEALTH_KEY
//   npx vitest run src/lib/integrations/catalogs/cabbity-health.live.test.ts

const KEY = process.env.CABBITY_HEALTH_KEY ?? '';
const { integration, operations } = CABBITY_HEALTH_CATALOG;

async function send(
  key: string,
  params: Record<string, unknown> = {},
  credential = KEY
) {
  const operation = operations.find((o) => o.key === key)!;
  const check = validateCallParams(operation.params, params);
  if (!check.ok) throw new Error(`invalid params for ${key}: ${check.param}`);
  const built = buildIntegrationRequest(integration, operation, check.values);
  if ('blocked' in built) throw new Error(`${key} blocked`);
  const [name, value] = authHeader(
    integration.auth_scheme,
    integration.auth_header_name,
    credential
  );
  return performIntegrationRequest('live-test', {
    ...built,
    headers: withAuthHeader(built.headers, name, value),
  });
}

function isoDate(daysFromToday: number): string {
  const d = new Date(Date.now() + daysFromToday * 86_400_000);
  return d.toISOString().slice(0, 10);
}

type Body<T> = { data: T };

describe.skipIf(!KEY)('Cabbity Health live (R23)', () => {
  beforeEach(() => {
    __resetRateLimitForTests();
  });

  it('get_center: the center and its 5 scopes', async () => {
    const r = await send('get_center');
    expect(r.outcome).toBe('ok');
    const body = r.data as Body<{
      center: { id: number; name: string; timezone: string };
      integration: { scopes: string[] };
    }>;
    expect(body.data.center.name).toEqual(expect.any(String));
    expect(body.data.center.timezone).toEqual(expect.any(String));
    expect(body.data.integration.scopes).toHaveLength(5);
    console.log(`center: ${body.data.center.name}`);
  });

  let locationId: number | null = null;

  it('list_practitioners: at least one with membership_id and location_ids', async () => {
    const r = await send('list_practitioners');
    expect(r.outcome).toBe('ok');
    const body = r.data as Body<
      { membership_id: number; location_ids: number[] }[]
    >;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const p of body.data) {
      expect(p.membership_id).toEqual(expect.any(Number));
      expect(Array.isArray(p.location_ids)).toBe(true);
    }
    locationId =
      body.data.find((p) => p.location_ids.length > 0)?.location_ids[0] ?? null;
    expect(locationId).not.toBeNull();
    console.log(`practitioners: ${body.data.length}`);
  });

  it('find_availability: 7 days in the first location → 200 and an array', async () => {
    const r = await send('find_availability', {
      location_id: locationId,
      from: isoDate(0),
      to: isoDate(6),
    });
    expect(r).toMatchObject({ outcome: 'ok', status: 200 });
    const body = r.data as Body<unknown[]>;
    expect(Array.isArray(body.data)).toBe(true);
    console.log(`slots: ${body.data.length}`);
  });

  it('lookup_patient with a phone that does not exist → not_found', async () => {
    // Por teléfono: un documento inventado puede no tener formato válido
    // (422 validation_failed en document_number, §M1).
    const r = await send('lookup_patient', { phone: '+18090000000' });
    expect(r.outcome).toBe('ok');
    expect((r.data as Body<{ source: string }>).data.source).toBe('not_found');
  });

  it('list_appointments with a scalar status is refused by Health (why it is not in the catalog)', async () => {
    // Fuera del catálogo a propósito: se arma a mano para vigilar si Health
    // empieza a aceptarlo.
    const r = await performIntegrationRequest('live-test', {
      url: `${integration.base_url}/appointments?from=${isoDate(0)}&to=${isoDate(6)}&status=confirmed`,
      method: 'GET',
      headers: withAuthHeader(
        { Accept: 'application/json' },
        'Authorization',
        `Bearer ${KEY}`
      ),
      body: undefined,
    });
    expect(r).toMatchObject({ outcome: 'http_error', status: 422 });
    expect(r.remoteError?.field).toBe('status');
  });

  it('find_availability with 20 days → validation_failed', async () => {
    const r = await send('find_availability', {
      location_id: locationId,
      from: isoDate(0),
      to: isoDate(20),
    });
    expect(r.outcome).toBe('http_error');
    expect(r.remoteError?.code).toBe('validation_failed');
  });

  it('get_center with an invalid key → 401 with remoteError', async () => {
    const r = await send('get_center', {}, 'invalid-key-for-test');
    expect(r).toMatchObject({ outcome: 'http_error', status: 401 });
    expect(r.remoteError?.code).toEqual(expect.any(String));
  });
});
