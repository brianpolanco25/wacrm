// ============================================================
// Catálogo de integraciones desde el panel de plataforma (n13.1).
//
// `integrations` e `integration_operations` son catálogo global (091,
// sin account_id), como `plans`: el operador las escribe aquí con el rol
// de servicio, detrás de `requirePlatformAdmin()` en la ruta. No hay
// borrado (R10): la FK desde `account_integrations` es RESTRICT y una
// integración se retira con `is_active = false`.
//
// Aislamiento: todo se filtra por `id` / `integration_id`. La única
// lectura que cruza cuentas es el recuento de activaciones del listado
// (`account_integrations` por `is_enabled`), que solo devuelve ids de
// integración; figura como waiver en `tenant-isolation.test.ts`.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';
import type {
  IntegrationRow,
  IntegrationWrite,
  OperationRow,
  OperationWrite,
} from '@/lib/integrations/types';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INTEGRATION_COLUMNS =
  'id, slug, name, description, logo_url, base_url, auth_scheme, auth_header_name, credential_help, test_path, is_active, sort_order, created_at, updated_at';
export const OPERATION_COLUMNS =
  'id, integration_id, key, name, description, method, path, params, outputs, response_description, is_active, sort_order';

export interface PlatformIntegrationSummary extends IntegrationRow {
  operationsActive: number;
  accountsEnabled: number;
}

export interface PlatformIntegrationDetail extends IntegrationRow {
  operations: OperationRow[];
}

export class IntegrationExistsError extends Error {
  constructor(slug: string) {
    super(`An integration with slug '${slug}' already exists`);
    this.name = 'IntegrationExistsError';
  }
}

export class OperationExistsError extends Error {
  constructor(key: string) {
    super(`An operation with key '${key}' already exists in this integration`);
    this.name = 'OperationExistsError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

/** Todas las integraciones, activas o no, con sus recuentos (R11). */
export async function loadPlatformIntegrations(): Promise<
  PlatformIntegrationSummary[]
> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('integrations')
    .select(INTEGRATION_COLUMNS)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as IntegrationRow[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const { data: ops, error: opsError } = await db
    .from('integration_operations')
    .select('integration_id, is_active')
    .in('integration_id', ids);
  if (opsError) throw opsError;

  // Waiver (tenant-isolation): recuento entre cuentas, solo ids de integración.
  const { data: enabled, error: enabledError } = await db
    .from('account_integrations')
    .select('integration_id')
    .eq('is_enabled', true);
  if (enabledError) throw enabledError;

  const opsCount = new Map<string, number>();
  for (const op of (ops ?? []) as {
    integration_id: string;
    is_active: boolean;
  }[]) {
    if (op.is_active) {
      opsCount.set(
        op.integration_id,
        (opsCount.get(op.integration_id) ?? 0) + 1
      );
    }
  }
  const accCount = new Map<string, number>();
  for (const row of (enabled ?? []) as { integration_id: string }[]) {
    accCount.set(
      row.integration_id,
      (accCount.get(row.integration_id) ?? 0) + 1
    );
  }

  return rows.map((row) => ({
    ...pickIntegration(row),
    operationsActive: opsCount.get(row.id) ?? 0,
    accountsEnabled: accCount.get(row.id) ?? 0,
  }));
}

/** Integración con sus operaciones; null si no existe. */
export async function loadPlatformIntegration(
  id: string
): Promise<PlatformIntegrationDetail | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('integrations')
    .select(INTEGRATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { data: ops, error: opsError } = await db
    .from('integration_operations')
    .select(OPERATION_COLUMNS)
    .eq('integration_id', id)
    .order('sort_order', { ascending: true })
    .order('key', { ascending: true });
  if (opsError) throw opsError;

  return {
    ...pickIntegration(data as IntegrationRow),
    operations: ((ops ?? []) as OperationRow[]).map(pickOperation),
  };
}

export async function createIntegration(
  value: IntegrationWrite,
  userId: string
): Promise<IntegrationRow> {
  const { data, error } = await supabaseAdmin()
    .from('integrations')
    // R5: nace en borrador pase lo que pase con el cuerpo.
    .insert({
      ...value,
      is_active: false,
      created_by: userId,
      updated_by: userId,
    })
    .select(INTEGRATION_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error))
      throw new IntegrationExistsError(String(value.slug));
    throw error;
  }
  return pickIntegration(data as IntegrationRow);
}

/** Null si no existe. */
export async function updateIntegration(
  id: string,
  value: IntegrationWrite,
  userId: string
): Promise<IntegrationRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('integrations')
    .update({ ...value, updated_by: userId })
    .eq('id', id)
    .select(INTEGRATION_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? pickIntegration(data as IntegrationRow) : null;
}

/** Operación de una integración concreta; null si no existe en ella. */
export async function loadOperation(
  integrationId: string,
  operationId: string
): Promise<OperationRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('integration_operations')
    .select(OPERATION_COLUMNS)
    .eq('integration_id', integrationId)
    .eq('id', operationId)
    .maybeSingle();
  if (error) throw error;
  return data ? pickOperation(data as OperationRow) : null;
}

export async function createOperation(
  integrationId: string,
  value: OperationWrite
): Promise<OperationRow> {
  const { data, error } = await supabaseAdmin()
    .from('integration_operations')
    .insert({ ...value, integration_id: integrationId })
    .select(OPERATION_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error))
      throw new OperationExistsError(String(value.key));
    throw error;
  }
  return pickOperation(data as OperationRow);
}

/** Null si la operación no existe en esa integración. */
export async function updateOperation(
  integrationId: string,
  operationId: string,
  value: OperationWrite
): Promise<OperationRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('integration_operations')
    .update(value)
    .eq('integration_id', integrationId)
    .eq('id', operationId)
    .select(OPERATION_COLUMNS)
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error))
      throw new OperationExistsError(String(value.key));
    throw error;
  }
  return data ? pickOperation(data as OperationRow) : null;
}

// La proyección real la hace PostgREST; esto fija la forma de la
// respuesta también frente a un cliente que devuelva filas enteras
// (`created_by`/`updated_by` no salen del panel).
function pickIntegration(row: IntegrationRow): IntegrationRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    logo_url: row.logo_url ?? null,
    base_url: row.base_url,
    auth_scheme: row.auth_scheme,
    auth_header_name: row.auth_header_name ?? null,
    credential_help: row.credential_help ?? null,
    test_path: row.test_path,
    is_active: Boolean(row.is_active),
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function pickOperation(row: OperationRow): OperationRow {
  return {
    id: row.id,
    integration_id: row.integration_id,
    key: row.key,
    name: row.name,
    description: row.description,
    method: row.method,
    path: row.path,
    params: Array.isArray(row.params) ? row.params : [],
    outputs: Array.isArray(row.outputs) ? row.outputs : [],
    response_description: row.response_description ?? null,
    is_active: row.is_active !== false,
    sort_order: row.sort_order ?? 0,
  };
}
