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

import { readStoredLiveReads } from '@/lib/ai/tools/live-templates';
import { isValidTimeZone } from '@/lib/ai/tools/prompt';
import {
  AI_INSTRUCTIONS_MAX,
  type AccountIntegrationAiFields,
  type AiReadOperation,
} from '@/lib/ai/tools/types';
import { encrypt } from '@/lib/whatsapp/encryption';

import { callerParams } from './request';
import type {
  AccountIntegrationView,
  AuthScheme,
  HttpMethod,
  IntegrationTestStatus,
  OperationParam,
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
  ai_enabled?: boolean | null;
  ai_instructions?: string | null;
  ai_timezone?: string | null;
  ai_live_reads?: unknown;
}

/** La vista de Ajustes con los campos de IA de n13.3 (R33). */
export type AccountIntegrationWithAi = AccountIntegrationView &
  AccountIntegrationAiFields;

interface OperationSummaryRow {
  integration_id: string;
  key: string;
  name: string;
  description: string;
  method: HttpMethod;
  is_active: boolean;
  sort_order: number;
  params?: OperationParam[] | null;
}

const CATALOG_COLUMNS =
  'id, slug, name, description, logo_url, auth_scheme, auth_header_name, credential_help, is_active, sort_order';
// Sin `credential`: ni el cifrado sale de aquí.
const ACTIVATION_COLUMNS =
  'integration_id, is_enabled, credential_last4, enabled_at, last_tested_at, last_test_status, ai_enabled, ai_instructions, ai_timezone, ai_live_reads';

/**
 * R14: integraciones activas del catálogo con sus operaciones activas, y
 * las retiradas que ESTA cuenta aún tiene activadas (`retired: true`),
 * cada una con el estado de la cuenta.
 */
export async function loadAccountIntegrations(
  db: SupabaseClient,
  accountId: string
): Promise<AccountIntegrationWithAi[]> {
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
      'integration_id, key, name, description, method, is_active, sort_order, params'
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
      // n13.3 (R33): solo con la integración activada.
      aiEnabled: enabled ? act?.ai_enabled === true : false,
      aiInstructions: enabled ? (act?.ai_instructions ?? null) : null,
      aiTimezone: enabled ? (act?.ai_timezone ?? null) : null,
      // n13.7 (R6): lecturas en vivo y operaciones que pueden serlo.
      aiLiveReads: enabled ? readStoredLiveReads(act?.ai_live_reads) : [],
      aiReadOperations: enabled
        ? readOperationsOf(opsBy.get(row.id) ?? [])
        : [],
    };
  });
}

/** n13.7 R6: operaciones `GET` activas con sus parámetros de llamada. */
function readOperationsOf(ops: OperationSummaryRow[]): AiReadOperation[] {
  return ops
    .filter((op) => op.method === 'GET')
    .map((op) => ({
      key: op.key,
      name: op.name,
      params: callerParams(Array.isArray(op.params) ? op.params : []).map(
        (p) => ({
          name: p.name,
          type: p.type,
          required: p.required === true,
          description: p.description ?? '',
          ...(Array.isArray(p.enum) && p.enum.length > 0
            ? { enum: [...p.enum] }
            : {}),
        })
      ),
    }));
}

/**
 * n13.7 R2: las operaciones de una integración (catálogo global por id,
 * sin `account_id`: waiver de n13.1) para validar las lecturas en vivo.
 */
export async function loadIntegrationOperationsForLiveReads(
  db: SupabaseClient,
  integrationId: string
): Promise<
  {
    key: string;
    method: HttpMethod;
    is_active: boolean;
    params: OperationParam[] | null;
  }[]
> {
  const { data, error } = await db
    .from('integration_operations')
    .select('key, method, is_active, params')
    .eq('integration_id', integrationId);
  if (error) throw error;
  return (data ?? []) as {
    key: string;
    method: HttpMethod;
    is_active: boolean;
    params: OperationParam[] | null;
  }[];
}

/** n13.7 R2: la zona guardada en la fila de ESTA cuenta. */
export async function loadAccountIntegrationTimezone(
  db: SupabaseClient,
  accountId: string,
  integrationId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('account_integrations')
    .select('ai_timezone')
    .eq('account_id', accountId)
    .eq('integration_id', integrationId)
    .maybeSingle();
  if (error) throw error;
  const tz = (data as { ai_timezone: string | null } | null)?.ai_timezone;
  return tz && isValidTimeZone(tz) ? tz : null;
}

/** La integración del catálogo si existe y está activa (para activar). */
export async function findActiveIntegration(
  db: SupabaseClient,
  integrationId: string
): Promise<{ id: string; slug: string } | null> {
  const { data, error } = await db
    .from('integrations')
    .select('id, slug, is_active')
    .eq('id', integrationId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { id: string; slug: string; is_active: boolean } | null;
  return row?.is_active ? { id: row.id, slug: row.slug } : null;
}

/**
 * El slug de una integración del catálogo, activa o retirada; `null` si no
 * existe. Para la traza de una sesión de soporte (n13.6), que nombra la
 * integración por su slug y no por el uuid de la ruta.
 */
export async function findIntegrationSlug(
  db: SupabaseClient,
  integrationId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('integrations')
    .select('slug')
    .eq('id', integrationId)
    .maybeSingle();
  if (error) throw error;
  return (data as { slug: string } | null)?.slug ?? null;
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

/** Columnas de IA que escribe el PATCH de Ajustes (n13.3, R32). */
export interface AiSettingsPatch {
  ai_enabled?: boolean;
  ai_instructions?: string | null;
  ai_timezone?: string | null;
  /**
   * n13.7: aquí solo con forma superficial (array o `null` → `[]`); la
   * ruta la valida contra las operaciones antes de guardar.
   */
  ai_live_reads?: unknown[];
}

export type AiSettingsValidation =
  | { ok: true; value: AiSettingsPatch }
  | {
      ok: false;
      field:
        'aiEnabled' | 'aiInstructions' | 'aiTimezone' | 'aiLiveReads' | 'body';
      error: string;
    };

/**
 * R32: `aiEnabled` boolean; `aiInstructions` texto ≤ 2000 o `null` (se
 * recorta; `''` → `null`); `aiTimezone` zona IANA válida o `null`. Al
 * menos una de las tres.
 */
export function validateAiSettings(body: unknown): AiSettingsValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, field: 'body', error: 'Body must be a JSON object' };
  }
  const input = body as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const value: AiSettingsPatch = {};

  if (has('aiEnabled')) {
    if (typeof input.aiEnabled !== 'boolean') {
      return {
        ok: false,
        field: 'aiEnabled',
        error: "'aiEnabled' must be a boolean",
      };
    }
    value.ai_enabled = input.aiEnabled;
  }
  if (has('aiInstructions')) {
    const raw = input.aiInstructions;
    if (raw === null) {
      value.ai_instructions = null;
    } else if (typeof raw !== 'string') {
      return {
        ok: false,
        field: 'aiInstructions',
        error: "'aiInstructions' must be a string or null",
      };
    } else {
      const trimmed = raw.trim();
      if (trimmed.length > AI_INSTRUCTIONS_MAX) {
        return {
          ok: false,
          field: 'aiInstructions',
          error: `'aiInstructions' must be at most ${AI_INSTRUCTIONS_MAX} characters`,
        };
      }
      value.ai_instructions = trimmed === '' ? null : trimmed;
    }
  }
  if (has('aiTimezone')) {
    const raw = input.aiTimezone;
    if (raw === null || raw === '') {
      value.ai_timezone = null;
    } else if (typeof raw !== 'string' || !isValidTimeZone(raw)) {
      return {
        ok: false,
        field: 'aiTimezone',
        error: "'aiTimezone' must be a valid IANA time zone or null",
      };
    } else {
      value.ai_timezone = raw;
    }
  }
  if (has('aiLiveReads')) {
    const raw = input.aiLiveReads;
    if (raw === null) {
      value.ai_live_reads = [];
    } else if (!Array.isArray(raw)) {
      return {
        ok: false,
        field: 'aiLiveReads',
        error: "'aiLiveReads' must be a list or null",
      };
    } else {
      value.ai_live_reads = raw;
    }
  }
  if (Object.keys(value).length === 0) {
    return {
      ok: false,
      field: 'body',
      error:
        "Send at least one of 'aiEnabled', 'aiInstructions', 'aiTimezone', 'aiLiveReads'",
    };
  }
  return { ok: true, value };
}

/**
 * R32: guarda los ajustes de IA en la fila de ESTA cuenta, solo si la
 * integración está activada. `false` = sin fila activada (404).
 */
export async function updateAccountIntegrationAi(
  db: SupabaseClient,
  accountId: string,
  integrationId: string,
  patch: AiSettingsPatch
): Promise<boolean> {
  const { data, error } = await db
    .from('account_integrations')
    .update(patch)
    .eq('account_id', accountId)
    .eq('integration_id', integrationId)
    .eq('is_enabled', true)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}
