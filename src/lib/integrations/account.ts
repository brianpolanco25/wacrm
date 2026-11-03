// ============================================================
// Activación de integraciones por cuenta (n13.1, R14, R15, R17).
//
// Rol de servicio: `account_integrations` no tiene políticas (091). Toda
// lectura y escritura de esa tabla va con `.eq('account_id', accountId)`
// y el upsert lleva `account_id` en la fila: es lo que vigila la
// auditoría de `tenant-isolation.test.ts`.
//
// La credencial entra aquí en claro (PUT) y sale cifrada hacia la base;
// este módulo nunca la descifra ni la devuelve (R20: el único `decrypt`
// es el de execute.ts).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { encrypt } from '@/lib/whatsapp/encryption';

import type {
  AccountIntegrationView,
  AuthScheme,
  HttpMethod,
  IntegrationTestStatus,
} from './types';

export const CREDENTIAL_MAX = 4096;

/**
 * R15: cadena de 1–4096 caracteres ASCII imprimibles: ni caracteres de
 * control ni saltos de línea (acabarían partiendo la cabecera), ni nada
 * fuera de ASCII. Devuelve la credencial tal
 * cual o `null` si no vale. No se recorta: un espacio puede ser parte
 * del secreto, pero uno al principio o al final casi siempre es un
 * error de pegado, así que también se rechaza.
 */
export function validateCredential(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length < 1 || raw.length > CREDENTIAL_MAX) return null;
  // Solo ASCII imprimible: va a una cabecera HTTP, y una comilla
  // tipográfica pegada desde un documento haría que `fetch` rechazara la
  // cabecera más tarde (`unreachable` en vez de un 400 aquí).
  if (/[^\x20-\x7e]/.test(raw)) return null;
  if (raw !== raw.trim()) return null;
  return raw;
}

/**
 * Los cuatro últimos caracteres, solo si la credencial es lo bastante
 * larga para que enseñarlos no la entregue entera (≥ 12).
 */
export function credentialLast4(credential: string): string | null {
  return credential.length >= 12 ? credential.slice(-4) : null;
}

interface CatalogRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  auth_scheme: AuthScheme;
  auth_header_name: string | null;
  credential_help: string | null;
  is_active: boolean;
  sort_order: number;
}

interface ActivationRow {
  integration_id: string;
  is_enabled: boolean;
  credential_last4: string | null;
  enabled_at: string | null;
  last_tested_at: string | null;
  last_test_status: IntegrationTestStatus | null;
}

interface OperationSummaryRow {
  integration_id: string;
  key: string;
  name: string;
  description: string;
  method: HttpMethod;
  is_active: boolean;
  sort_order: number;
}

const CATALOG_COLUMNS =
  'id, slug, name, description, logo_url, auth_scheme, auth_header_name, credential_help, is_active, sort_order';
// Sin `credential`: ni el cifrado sale de aquí.
const ACTIVATION_COLUMNS =
  'integration_id, is_enabled, credential_last4, enabled_at, last_tested_at, last_test_status';

/**
 * R14: integraciones activas del catálogo con sus operaciones activas, y
 * las retiradas que ESTA cuenta aún tiene activadas (`retired: true`),
 * cada una con el estado de la cuenta.
 */
export async function loadAccountIntegrations(
  db: SupabaseClient,
  accountId: string
): Promise<AccountIntegrationView[]> {
  const { data: acts, error: actsError } = await db
    .from('account_integrations')
    .select(ACTIVATION_COLUMNS)
    .eq('account_id', accountId);
  if (actsError) throw actsError;
  const byIntegration = new Map<string, ActivationRow>();
  for (const a of (acts ?? []) as ActivationRow[])
    byIntegration.set(a.integration_id, a);

  // Catálogo global (waiver): sin account_id que filtrar.
  const { data: catalog, error: catalogError } = await db
    .from('integrations')
    .select(CATALOG_COLUMNS)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (catalogError) throw catalogError;

  const visible = ((catalog ?? []) as CatalogRow[]).filter(
    (row) => row.is_active || byIntegration.get(row.id)?.is_enabled === true
  );
  if (visible.length === 0) return [];

  const { data: ops, error: opsError } = await db
    .from('integration_operations')
    .select(
      'integration_id, key, name, description, method, is_active, sort_order'
    )
    .in(
      'integration_id',
      visible.map((v) => v.id)
    )
    .order('sort_order', { ascending: true });
  if (opsError) throw opsError;
  const opsBy = new Map<string, OperationSummaryRow[]>();
  for (const op of (ops ?? []) as OperationSummaryRow[]) {
    if (!op.is_active) continue;
    const list = opsBy.get(op.integration_id) ?? [];
    list.push(op);
    opsBy.set(op.integration_id, list);
  }

  return visible.map((row) => {
    const act = byIntegration.get(row.id);
    const enabled = act?.is_enabled === true;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description ?? null,
      logoUrl: row.logo_url ?? null,
      authScheme: row.auth_scheme,
      authHeaderName: row.auth_header_name ?? null,
      credentialHelp: row.credential_help ?? null,
      retired: !row.is_active,
      operations: (opsBy.get(row.id) ?? []).map((op) => ({
        key: op.key,
        name: op.name,
        description: op.description,
        method: op.method,
      })),
      enabled,
      credentialLast4: enabled ? (act?.credential_last4 ?? null) : null,
      enabledAt: enabled ? (act?.enabled_at ?? null) : null,
      lastTestedAt: enabled ? (act?.last_tested_at ?? null) : null,
      lastTestStatus: enabled ? (act?.last_test_status ?? null) : null,
    };
  });
}

/** La integración del catálogo si existe y está activa (para activar). */
export async function findActiveIntegration(
  db: SupabaseClient,
  integrationId: string
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from('integrations')
    .select('id, is_active')
    .eq('id', integrationId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { id: string; is_active: boolean } | null;
  return row?.is_active ? { id: row.id } : null;
}

/**
 * R15: activa o cambia la credencial. Una fila por cuenta e integración
 * (upsert); la prueba anterior deja de valer.
 */
export async function enableAccountIntegration(
  db: SupabaseClient,
  input: {
    accountId: string;
    integrationId: string;
    userId: string;
    credential: string;
  }
): Promise<void> {
  const { error } = await db.from('account_integrations').upsert(
    {
      account_id: input.accountId,
      integration_id: input.integrationId,
      is_enabled: true,
      credential: encrypt(input.credential),
      credential_last4: credentialLast4(input.credential),
      enabled_by: input.userId,
      enabled_at: new Date().toISOString(),
      last_tested_at: null,
      last_test_status: null,
    },
    { onConflict: 'account_id,integration_id' }
  );
  if (error) throw error;
}

/**
 * R17 / D5: desactiva y BORRA la credencial; la fila queda para el
 * registro. `false` si la cuenta nunca la activó.
 */
export async function disableAccountIntegration(
  db: SupabaseClient,
  accountId: string,
  integrationId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('account_integrations')
    .update({ is_enabled: false, credential: null, credential_last4: null })
    .eq('account_id', accountId)
    .eq('integration_id', integrationId)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}
