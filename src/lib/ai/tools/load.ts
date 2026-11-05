// ============================================================
// Carga de las herramientas de IA de una cuenta (n13.3, R1–R5, R28).
//
// Rol de servicio: `account_integrations` no tiene políticas (091), así
// que su lectura va SIEMPRE con `.eq('account_id', accountId)` (CP3). El
// catálogo (`integrations`, `integration_operations`) es global y se lee
// por id. Nunca lanza: cualquier fallo → sin herramientas, como antes de
// n13.3, con un mensaje fijo en consola (R3).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getEntitlements,
  hasFeature,
  type Entitlements,
} from '@/lib/billing/entitlements';
import type { HttpMethod, OperationParam } from '@/lib/integrations/types';

import { isValidTimeZone } from './prompt';
import { buildAiTools, type ToolSourceRow } from './schema';
import {
  EMPTY_TOOLSET,
  type AiToolIntegration,
  type AiToolMode,
  type AiToolset,
} from './types';

interface ActivationRow {
  integration_id: string;
  ai_instructions: string | null;
  ai_timezone: string | null;
}

interface IntegrationRow {
  id: string;
  slug: string;
  name: string;
  sort_order: number | null;
  is_active: boolean;
}

interface OperationRow {
  integration_id: string;
  key: string;
  name: string;
  description: string | null;
  method: HttpMethod;
  params: OperationParam[] | null;
  response_description: string | null;
  sort_order: number | null;
  is_active: boolean;
}

export async function loadAiToolset(
  db: SupabaseClient,
  accountId: string,
  opts: { mode: AiToolMode; entitlements?: Entitlements },
  deps: { getEntitlements?: (accountId: string) => Promise<Entitlements> } = {}
): Promise<AiToolset> {
  try {
    const entitlements =
      opts.entitlements ??
      (await (deps.getEntitlements ?? getEntitlements)(accountId));
    if (!hasFeature(entitlements, 'integrations')) return EMPTY_TOOLSET;

    const { data: acts, error: actsError } = await db
      .from('account_integrations')
      .select('integration_id, ai_instructions, ai_timezone')
      .eq('account_id', accountId)
      .eq('is_enabled', true)
      .eq('ai_enabled', true)
      .not('credential', 'is', null);
    if (actsError) throw actsError;
    const activations = (acts ?? []) as ActivationRow[];
    if (activations.length === 0) return EMPTY_TOOLSET;

    // Catálogo global (waiver de n13.1): por id, solo las activas.
    const { data: integ, error: integError } = await db
      .from('integrations')
      .select('id, slug, name, sort_order, is_active')
      .in(
        'id',
        activations.map((a) => a.integration_id)
      )
      .eq('is_active', true);
    if (integError) throw integError;
    const integrations = ((integ ?? []) as IntegrationRow[]).filter(
      (i) => i.is_active
    );
    if (integrations.length === 0) return EMPTY_TOOLSET;

    const { data: ops, error: opsError } = await db
      .from('integration_operations')
      .select(
        'integration_id, key, name, description, method, params, response_description, sort_order, is_active'
      )
      .in(
        'integration_id',
        integrations.map((i) => i.id)
      )
      .eq('is_active', true);
    if (opsError) throw opsError;

    const byId = new Map(integrations.map((i) => [i.id, i]));
    const rows: ToolSourceRow[] = [];
    for (const op of (ops ?? []) as OperationRow[]) {
      const integration = byId.get(op.integration_id);
      if (!integration || !op.is_active) continue;
      rows.push({
        integration: {
          slug: integration.slug,
          name: integration.name,
          sortOrder: integration.sort_order ?? 0,
        },
        operation: {
          key: op.key,
          name: op.name,
          description: op.description ?? '',
          method: op.method,
          params: Array.isArray(op.params) ? op.params : [],
          responseDescription: op.response_description ?? null,
          sortOrder: op.sort_order ?? 0,
        },
      });
    }

    const tools = buildAiTools(rows, { mode: opts.mode });
    if (tools.length === 0) return EMPTY_TOOLSET;
    const usedSlugs = new Set(tools.map((t) => t.integrationSlug));
    const activationOf = new Map(activations.map((a) => [a.integration_id, a]));
    const toolIntegrations: AiToolIntegration[] = integrations
      .filter((i) => usedSlugs.has(i.slug))
      .map((i) => {
        const act = activationOf.get(i.id);
        const timezone = act?.ai_timezone ?? null;
        return {
          slug: i.slug,
          name: i.name,
          instructions: act?.ai_instructions?.trim() || null,
          timezone: timezone && isValidTimeZone(timezone) ? timezone : null,
        };
      });
    return { tools, integrations: toolIntegrations };
  } catch {
    // R3: sin el error (podría llevar texto de la base) ni datos de la cuenta.
    console.error('[ai tools] could not load tools for account', accountId);
    return EMPTY_TOOLSET;
  }
}
