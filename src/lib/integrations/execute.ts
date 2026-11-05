// ============================================================
// Ejecutor de integraciones (n13.1, R18, R20, R27, R28, R30).
//
//   executeIntegrationOperation  la API que consumirán el nodo de flow
//                                (n13.2), la IA (n13.3) y las
//                                automatizaciones (n13.4). Nunca lanza.
//   testIntegrationConnection    la prueba de conexión de Ajustes.
//
// Este es el ÚNICO archivo que descifra `account_integrations.credential`
// (R20). La credencial va a la cabecera de la petición y a ningún otro
// sitio: ni a consola, ni a `integration_calls`, ni a la respuesta.
//
// Aislamiento: `account_integrations` se lee y se escribe siempre con
// `.eq('account_id', accountId)`, e `integration_calls` lleva el
// `account_id` explícito en la fila. El catálogo (`integrations`,
// `integration_operations`) es global: se lee por slug / id.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getEntitlements,
  hasFeature,
  type Entitlements,
} from '@/lib/billing/entitlements';
import { decrypt } from '@/lib/whatsapp/encryption';

import {
  performIntegrationRequest,
  type HttpOutcome,
  type IntegrationHttpDeps,
} from './http';
import {
  authHeader,
  buildIntegrationRequest,
  validateCallParams,
  withAuthHeader,
} from './request';
import type {
  AuthScheme,
  HttpMethod,
  IntegrationTestStatus,
  OperationParam,
  RemoteError,
} from './types';

export type IntegrationCallSource = 'test' | 'flow' | 'ai' | 'automation';
export type IntegrationCallOutcome =
  HttpOutcome | 'invalid_params' | 'not_enabled' | 'error';

export type IntegrationCallResult =
  | { ok: true; status: number; data: unknown; latencyMs: number }
  | {
      ok: false;
      outcome: Exclude<IntegrationCallOutcome, 'ok'>;
      status: number | null;
      latencyMs: number;
      /**
       * n13.5 (D5): solo con `http_error` y un cuerpo de error reconocible
       * (`{error:{code,…}}`). Texto de un tercero: dato, no instrucción.
       * No se guarda en `integration_calls`.
       */
      remoteError?: RemoteError;
    };

export type ExecuteDeps = IntegrationHttpDeps & {
  entitlements?: (accountId: string) => Promise<Entitlements>;
  /** Tests: generador de las cabeceras `auto: 'uuid'` (n13.5). */
  uuid?: () => string;
};

interface IntegrationLookup {
  id: string;
  base_url: string;
  auth_scheme: AuthScheme;
  auth_header_name: string | null;
  test_path: string;
  is_active: boolean;
}

interface ActivationLookup {
  is_enabled: boolean;
  credential: string | null;
}

interface OperationLookup {
  key: string;
  method: HttpMethod;
  path: string;
  params: OperationParam[] | null;
  is_active: boolean;
}

const INTEGRATION_LOOKUP =
  'id, base_url, auth_scheme, auth_header_name, test_path, is_active';

/** Inserta la fila de R28; un fallo aquí no cambia el resultado. */
async function recordIntegrationCall(
  db: SupabaseClient,
  row: {
    accountId: string;
    integrationId: string;
    operationKey: string | null;
    source: IntegrationCallSource;
    outcome: IntegrationCallOutcome;
    statusCode: number | null;
    latencyMs: number;
  }
): Promise<void> {
  try {
    const { error } = await db.from('integration_calls').insert({
      account_id: row.accountId,
      integration_id: row.integrationId,
      operation_key: row.operationKey,
      source: row.source,
      outcome: row.outcome,
      status_code: row.statusCode,
      latency_ms: row.latencyMs,
    });
    if (error) {
      console.error(
        '[integrations] could not record the call:',
        (error as { code?: unknown }).code ?? 'unknown'
      );
    }
  } catch {
    console.error('[integrations] could not record the call:', 'exception');
  }
}

async function loadActivation(
  db: SupabaseClient,
  accountId: string,
  integrationId: string
): Promise<ActivationLookup | null> {
  const { data, error } = await db
    .from('account_integrations')
    .select('is_enabled, credential')
    .eq('account_id', accountId)
    .eq('integration_id', integrationId)
    .maybeSingle();
  if (error) throw error;
  return (data as ActivationLookup | null) ?? null;
}

/**
 * Ejecuta una operación del catálogo para una cuenta. Nunca lanza: todo
 * fallo es `{ ok: false, outcome }` y queda en `integration_calls`
 * (salvo una integración que no existe, que no tiene id que registrar).
 */
export async function executeIntegrationOperation(
  db: SupabaseClient,
  input: {
    accountId: string;
    integrationSlug: string;
    operationKey: string;
    params: Record<string, unknown>;
    source: Exclude<IntegrationCallSource, 'test'>;
  },
  deps: ExecuteDeps = {}
): Promise<IntegrationCallResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  let integrationId: string | null = null;

  const finish = async (
    outcome: IntegrationCallOutcome,
    status: number | null,
    latencyMs: number,
    data: unknown = null,
    remoteError?: RemoteError
  ): Promise<IntegrationCallResult> => {
    if (integrationId) {
      await recordIntegrationCall(db, {
        accountId: input.accountId,
        integrationId,
        operationKey: input.operationKey,
        source: input.source,
        outcome,
        statusCode: status,
        latencyMs,
      });
    }
    if (outcome === 'ok' && status !== null) {
      return { ok: true, status, data, latencyMs };
    }
    return {
      ok: false,
      outcome: outcome === 'ok' ? 'error' : outcome,
      status,
      latencyMs,
      ...(remoteError ? { remoteError } : {}),
    };
  };

  try {
    const { data: integ, error: integError } = await db
      .from('integrations')
      .select(INTEGRATION_LOOKUP)
      .eq('slug', input.integrationSlug)
      .maybeSingle();
    if (integError) throw integError;
    if (!integ) {
      return {
        ok: false,
        outcome: 'not_enabled',
        status: null,
        latencyMs: elapsed(),
      };
    }
    const integration = integ as IntegrationLookup;
    integrationId = integration.id;
    if (!integration.is_active) return finish('not_enabled', null, elapsed());

    const activation = await loadActivation(
      db,
      input.accountId,
      integration.id
    );
    if (!activation?.is_enabled || !activation.credential) {
      return finish('not_enabled', null, elapsed());
    }

    const { data: op, error: opError } = await db
      .from('integration_operations')
      .select('key, method, path, params, is_active')
      .eq('integration_id', integration.id)
      .eq('key', input.operationKey)
      .maybeSingle();
    if (opError) throw opError;
    const operation = op as OperationLookup | null;
    if (!operation || !operation.is_active) {
      return finish('not_enabled', null, elapsed());
    }

    const entitlements = await (deps.entitlements ?? getEntitlements)(
      input.accountId
    );
    if (!hasFeature(entitlements, 'integrations')) {
      return finish('not_enabled', null, elapsed());
    }

    const params = operation.params ?? [];
    const check = validateCallParams(params, input.params);
    if (!check.ok) return finish('invalid_params', null, elapsed());

    const built = buildIntegrationRequest(
      integration,
      { method: operation.method, path: operation.path, params },
      check.values,
      { uuid: deps.uuid }
    );
    if ('blocked' in built) return finish('blocked', null, elapsed());

    const [name, value] = authHeader(
      integration.auth_scheme,
      integration.auth_header_name,
      decrypt(activation.credential)
    );
    const result = await performIntegrationRequest(
      input.accountId,
      { ...built, headers: withAuthHeader(built.headers, name, value) },
      deps
    );
    return finish(
      result.outcome,
      result.status,
      result.latencyMs,
      result.data,
      result.remoteError
    );
  } catch {
    // Sin el error: podría llevar texto de la base o del descifrado.
    console.error('[integrations] the call failed unexpectedly');
    return finish('error', null, elapsed());
  }
}

/** R18: resultado HTTP → estado de la prueba. */
export function testStatusFor(
  outcome: IntegrationCallOutcome,
  status: number | null
): IntegrationTestStatus {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'http_error' && (status === 401 || status === 403)) {
    return 'auth_failed';
  }
  if (
    outcome === 'timeout' ||
    outcome === 'unreachable' ||
    outcome === 'blocked'
  ) {
    return 'unreachable';
  }
  return 'error';
}

export type IntegrationTestResult =
  | { result: IntegrationTestStatus; status: number | null; testedAt: string }
  | { rateLimited: true };

/**
 * Prueba de conexión: `GET base_url + test_path` con la credencial de
 * ESTA cuenta. `null` si la integración no existe, está retirada o la
 * cuenta no la tiene activada. El plan lo comprueba la ruta.
 */
export async function testIntegrationConnection(
  db: SupabaseClient,
  accountId: string,
  integrationId: string,
  deps: IntegrationHttpDeps = {}
): Promise<IntegrationTestResult | null> {
  const now = deps.now ?? Date.now;
  const started = now();

  const { data: integ, error: integError } = await db
    .from('integrations')
    .select(INTEGRATION_LOOKUP)
    .eq('id', integrationId)
    .maybeSingle();
  if (integError) throw integError;
  const integration = integ as IntegrationLookup | null;
  if (!integration || !integration.is_active) return null;

  const activation = await loadActivation(db, accountId, integrationId);
  if (!activation?.is_enabled || !activation.credential) return null;

  let outcome: IntegrationCallOutcome;
  let status: number | null = null;
  let latencyMs: number;
  try {
    const built = buildIntegrationRequest(
      integration,
      { method: 'GET', path: integration.test_path, params: [] },
      {}
    );
    if ('blocked' in built) {
      outcome = 'blocked';
      latencyMs = Math.max(0, Math.round(now() - started));
    } else {
      const [name, value] = authHeader(
        integration.auth_scheme,
        integration.auth_header_name,
        decrypt(activation.credential)
      );
      const res = await performIntegrationRequest(
        accountId,
        { ...built, headers: withAuthHeader(built.headers, name, value) },
        deps
      );
      outcome = res.outcome;
      status = res.status;
      latencyMs = res.latencyMs;
    }
  } catch {
    console.error('[integrations] the connection test failed unexpectedly');
    outcome = 'error';
    latencyMs = Math.max(0, Math.round(now() - started));
  }

  await recordIntegrationCall(db, {
    accountId,
    integrationId,
    operationKey: null,
    source: 'test',
    outcome,
    statusCode: status,
    latencyMs,
  });

  if (outcome === 'rate_limited') return { rateLimited: true };

  const result = testStatusFor(outcome, status);
  const testedAt = new Date(now()).toISOString();
  const { error: updateError } = await db
    .from('account_integrations')
    .update({ last_tested_at: testedAt, last_test_status: result })
    .eq('account_id', accountId)
    .eq('integration_id', integrationId);
  if (updateError) {
    console.error(
      '[integrations] could not store the test result:',
      (updateError as { code?: unknown }).code ?? 'unknown'
    );
  }
  return { result, status, testedAt };
}
