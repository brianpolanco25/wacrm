import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Entitlements } from '@/lib/billing/entitlements';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { FakeDatabase } from '@/lib/security/fake-supabase';
import { encrypt } from '@/lib/whatsapp/encryption';

import { executeIntegrationOperation } from '../execute';
import { ACCOUNT_A } from '../integrations.test-support';
import { CABBITY_HEALTH_CATALOG } from './cabbity-health';

// n13.5 (R22): las operaciones del catálogo de Cabbity Health, ejecutadas
// por el ejecutor común con fetch simulado, producen la petición exacta
// que espera el OpenAPI.

const BASE = 'https://api.health.cabbity.com/api/integrations/v1';
const CREDENTIAL = 'test-credential-health-0001';
const INTEGRATION_ID = '9c000000-0000-4000-8000-000000000001';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let db: FakeDatabase;
let fetchSpy: ReturnType<typeof vi.fn>;

function seed(): FakeDatabase {
  const { integration, operations } = CABBITY_HEALTH_CATALOG;
  return new FakeDatabase({
    integrations: [{ ...integration, id: INTEGRATION_ID, is_active: true }],
    // Todas encendidas aquí: lo que se prueba es la petición.
    integration_operations: operations.map((op, i) => ({
      ...op,
      id: `9d000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      integration_id: INTEGRATION_ID,
      is_active: true,
    })),
    account_integrations: [
      {
        id: 'ai-a-health',
        account_id: ACCOUNT_A,
        integration_id: INTEGRATION_ID,
        is_enabled: true,
        credential: encrypt(CREDENTIAL),
        credential_last4: '0001',
        enabled_by: null,
        enabled_at: '2026-11-05T10:00:00.000Z',
        last_tested_at: null,
        last_test_status: null,
      },
    ],
    integration_calls: [],
  });
}

async function call(operationKey: string, params: Record<string, unknown>) {
  const r = await executeIntegrationOperation(
    db.admin as unknown as SupabaseClient,
    {
      accountId: ACCOUNT_A,
      integrationSlug: 'cabbity-health',
      operationKey,
      params,
      source: 'ai',
    },
    {
      fetch: fetchSpy as unknown as typeof fetch,
      isDeliverable: async () => true,
      entitlements: async () =>
        ({ features: ['integrations'] }) as unknown as Entitlements,
    }
  );
  expect(r).toMatchObject({ ok: true, status: 200 });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
  return {
    url,
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

beforeEach(() => {
  __resetRateLimitForTests();
  db = seed();
  fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
});

describe('Cabbity Health requests with a simulated fetch (R22)', () => {
  it('find_availability: GET with the query, no body, no Idempotency-Key', async () => {
    const r = await call('find_availability', {
      location_id: '3',
      from: '2026-11-09',
      to: '2026-11-15',
      membership_id: 10,
    });
    expect(r.method).toBe('GET');
    expect(r.url).toBe(
      `${BASE}/availability?location_id=3&from=2026-11-09&to=2026-11-15&membership_id=10`
    );
    expect(r.body).toBeUndefined();
    expect(r.headers['Idempotency-Key']).toBeUndefined();
  });

  it('get_practitioner: the id in the path', async () => {
    const r = await call('get_practitioner', { id: 10 });
    expect(r.method).toBe('GET');
    expect(r.url).toBe(`${BASE}/practitioners/10`);
    expect(r.headers['Idempotency-Key']).toBeUndefined();
  });

  it('lookup_patient: read-only POST without Idempotency-Key', async () => {
    const r = await call('lookup_patient', {
      document_type: 'cedula',
      document_number: '00000000000',
    });
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`${BASE}/patients/lookup`);
    expect(r.body).toEqual({
      document_type: 'cedula',
      document_number: '00000000000',
    });
    expect(r.headers['Idempotency-Key']).toBeUndefined();
  });

  it('create_patient: nested consent and an Idempotency-Key', async () => {
    const r = await call('create_patient', {
      first_name: 'Ana',
      last_name: 'Pérez',
      document_type: 'cedula',
      document_number: '00000000000',
      phone: '+18095550000',
      consent: {
        accepted: true,
        accepted_at: '2026-11-05T10:15:00-04:00',
        reference: 'WhatsApp, conversación del 2026-11-05',
      },
    });
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`${BASE}/patients`);
    expect(r.headers['Content-Type']).toBe('application/json');
    expect(r.headers['Idempotency-Key']).toMatch(UUID_V4);
    expect(r.body).toEqual({
      first_name: 'Ana',
      last_name: 'Pérez',
      document_type: 'cedula',
      document_number: '00000000000',
      phone: '+18095550000',
      consent: {
        accepted: true,
        accepted_at: '2026-11-05T10:15:00-04:00',
        reference: 'WhatsApp, conversación del 2026-11-05',
      },
    });
  });

  it('create_appointment: body and an Idempotency-Key', async () => {
    const r = await call('create_appointment', {
      patient_id: 42,
      membership_id: 10,
      location_id: 3,
      starts_at: '2026-11-12T10:30:00-04:00',
    });
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`${BASE}/appointments`);
    expect(r.headers['Idempotency-Key']).toMatch(UUID_V4);
    expect(r.body).toEqual({
      patient_id: 42,
      membership_id: 10,
      location_id: 3,
      starts_at: '2026-11-12T10:30:00-04:00',
    });
  });

  it('list_appointments: patient and range in the query', async () => {
    const r = await call('list_appointments', {
      patient_id: 42,
      from: '2026-11-09',
      to: '2026-11-15',
    });
    expect(r.method).toBe('GET');
    expect(r.url).toBe(
      `${BASE}/appointments?patient_id=42&from=2026-11-09&to=2026-11-15`
    );
    expect(r.body).toBeUndefined();
    expect(r.headers['Idempotency-Key']).toBeUndefined();
  });

  it('confirm_appointment: POST without a body, with an Idempotency-Key', async () => {
    const r = await call('confirm_appointment', { id: 77 });
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`${BASE}/appointments/77/confirm`);
    expect(r.body).toBeUndefined();
    expect(r.headers['Content-Type']).toBeUndefined();
    expect(r.headers['Idempotency-Key']).toMatch(UUID_V4);
  });

  it('cancel_appointment without a reason: no body', async () => {
    const r = await call('cancel_appointment', { id: 77 });
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`${BASE}/appointments/77/cancel`);
    expect(r.body).toBeUndefined();
    expect(r.headers['Idempotency-Key']).toMatch(UUID_V4);
  });

  it('cancel_appointment with a reason: {"reason": …}', async () => {
    const r = await call('cancel_appointment', { id: 77, reason: 'Viaje' });
    expect(r.body).toEqual({ reason: 'Viaje' });
  });

  it('list_appointments without patient_id is refused before any request (D1)', async () => {
    const r = await executeIntegrationOperation(
      db.admin as unknown as SupabaseClient,
      {
        accountId: ACCOUNT_A,
        integrationSlug: 'cabbity-health',
        operationKey: 'list_appointments',
        params: { from: '2026-11-01', to: '2026-11-07' },
        source: 'ai',
      },
      {
        fetch: fetchSpy as unknown as typeof fetch,
        isDeliverable: async () => true,
        entitlements: async () =>
          ({ features: ['integrations'] }) as unknown as Entitlements,
      }
    );
    expect(r).toMatchObject({ ok: false, outcome: 'invalid_params' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
