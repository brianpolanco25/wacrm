/**
 * Test support del catálogo de integraciones (n13.1). Solo lo importan
 * archivos `*.test.ts(x)`.
 *
 * `seedIntegrationTables()` deja el catálogo y las activaciones como los
 * tendría una base migrada (091) para `FakeDatabase`: `health` activa con
 * dos operaciones (una retirada), un borrador y una integración retirada;
 * la cuenta B activó `health` ANTES que A, cada una con su credencial.
 */

import type { Row, Tables } from '@/lib/security/fake-supabase';

export const OPERATOR = '11111111-1111-4111-8111-111111111111';
export const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';

export const ACCOUNT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const ACCOUNT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

export const HEALTH_ID = '9a000000-0000-4000-8000-000000000001';
export const DRAFT_ID = '9a000000-0000-4000-8000-000000000002';
export const RETIRED_ID = '9a000000-0000-4000-8000-000000000003';
export const OP_LIST_ID = '9b000000-0000-4000-8000-000000000001';
export const OP_CREATE_ID = '9b000000-0000-4000-8000-000000000002';
export const OP_OLD_ID = '9b000000-0000-4000-8000-000000000003';

export function integration(overrides: Row): Row {
  return {
    description: null,
    logo_url: null,
    auth_scheme: 'bearer',
    auth_header_name: null,
    credential_help: null,
    test_path: '/me',
    is_active: true,
    sort_order: 0,
    created_by: OPERATOR,
    updated_by: OPERATOR,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

export function seedIntegrationTables(): Tables {
  return {
    platform_admins: [
      { id: 'pa-1', user_id: OPERATOR, granted_at: null, note: 'test' },
    ],
    integrations: [
      integration({
        id: HEALTH_ID,
        slug: 'health',
        name: 'Cabbity Health',
        description: 'Citas y doctores',
        base_url: 'https://health.example.com/api/v1',
        sort_order: 1,
      }),
      integration({
        id: DRAFT_ID,
        slug: 'draft-app',
        name: 'Borrador',
        base_url: 'https://draft.example.com',
        is_active: false,
        sort_order: 2,
      }),
      integration({
        id: RETIRED_ID,
        slug: 'old-app',
        name: 'Retirada',
        base_url: 'https://old.example.com',
        auth_scheme: 'header',
        auth_header_name: 'X-Api-Key',
        is_active: false,
        sort_order: 3,
      }),
    ],
    integration_operations: [
      {
        id: OP_LIST_ID,
        integration_id: HEALTH_ID,
        key: 'list_doctors',
        name: 'Listar doctores',
        description: 'Devuelve los doctores de la clínica',
        method: 'GET',
        path: '/doctors',
        params: [
          {
            name: 'specialty',
            in: 'query',
            type: 'string',
            required: false,
            description: 'Especialidad',
          },
        ],
        outputs: [],
        response_description: null,
        is_active: true,
        sort_order: 1,
      },
      {
        id: OP_CREATE_ID,
        integration_id: HEALTH_ID,
        key: 'create_appointment',
        name: 'Crear cita',
        description: 'Crea una cita',
        method: 'POST',
        path: '/doctors/{doctorId}/appointments',
        params: [
          {
            name: 'doctorId',
            in: 'path',
            type: 'integer',
            required: true,
            description: 'Doctor',
          },
          {
            name: 'starts_at',
            in: 'body',
            type: 'string',
            required: true,
            description: 'Inicio',
          },
        ],
        outputs: [],
        response_description: null,
        is_active: true,
        sort_order: 2,
      },
      {
        id: OP_OLD_ID,
        integration_id: HEALTH_ID,
        key: 'old_op',
        name: 'Vieja',
        description: 'Retirada',
        method: 'GET',
        path: '/old',
        params: [],
        outputs: [],
        response_description: null,
        is_active: false,
        sort_order: 3,
      },
    ],
    account_integrations: [
      {
        id: 'ai-b-health',
        account_id: ACCOUNT_B,
        integration_id: HEALTH_ID,
        is_enabled: true,
        credential: 'enc-b',
        credential_last4: 'bbbb',
        enabled_by: null,
        enabled_at: '2026-11-01T10:00:00.000Z',
        last_tested_at: null,
        last_test_status: null,
      },
      {
        id: 'ai-b-retired',
        account_id: ACCOUNT_B,
        integration_id: RETIRED_ID,
        is_enabled: true,
        credential: 'enc-b2',
        credential_last4: 'bb22',
        enabled_by: null,
        enabled_at: '2026-11-01T10:00:00.000Z',
        last_tested_at: null,
        last_test_status: null,
      },
    ],
    integration_calls: [
      {
        id: 'call-b-1',
        account_id: ACCOUNT_B,
        integration_id: HEALTH_ID,
        operation_key: null,
        source: 'test',
        outcome: 'ok',
        status_code: 200,
        latency_ms: 20,
      },
    ],
  };
}

export const USER_A = 'a0000000-0000-4000-8000-0000000000a1';

/** Contexto de cuenta como lo devuelve `requireRole` / `getCurrentAccount`. */
export function accountCtx(
  role: 'owner' | 'admin' | 'agent' | 'viewer',
  options: { accountId?: string; userId?: string; impersonated?: boolean } = {}
) {
  const accountId = options.accountId ?? ACCOUNT_A;
  return {
    supabase: {},
    userId: options.userId ?? USER_A,
    accountId,
    role,
    account: { id: accountId, name: 'Cuenta' },
    impersonation: options.impersonated
      ? { accountId, logId: 'log-1', operatorId: OPERATOR }
      : null,
  };
}

/** Entitlements mínimos con o sin la feature `integrations`. */
export function entitlementsWith(features: string[]) {
  return {
    planId: 'pro',
    status: 'active',
    limits: {},
    features,
    readOnly: false,
    readOnlyReason: null,
    manualHold: false,
    trialEndsAt: null,
    metaBilling: 'direct',
    paymentMethod: null,
    openStatement: null,
  };
}
