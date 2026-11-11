// ============================================================
// Evidencia previa de una conversación para la guardia de operaciones
// destructivas (n13.7, R28, R31, R34).
//
// Rol de servicio: `integration_calls` no tiene políticas, así que la
// lectura va SIEMPRE con `.eq('account_id', accountId)` (CP3). El
// catálogo (`integrations`) es global y se lee por id. Nunca lanza: un
// fallo es evidencia vacía (las herramientas con `requires_prior` quedan
// bloqueadas en ese turno).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { AI_EVIDENCE_WINDOW_MS, type PriorEvidence } from './types';

interface CallRow {
  integration_id: string;
  operation_key: string | null;
  created_at: string;
}

/**
 * Llamadas `ok` de la IA (no lecturas en vivo) en esta conversación en
 * las últimas 24 h, en orden de creación.
 */
export async function loadPriorEvidence(
  db: SupabaseClient,
  accountId: string,
  conversationId: string | null,
  now: Date
): Promise<PriorEvidence[]> {
  if (!conversationId) return [];
  try {
    const since = new Date(now.getTime() - AI_EVIDENCE_WINDOW_MS).toISOString();
    const { data, error } = await db
      .from('integration_calls')
      .select('integration_id, operation_key, created_at')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .eq('source', 'ai')
      .eq('ai_preload', false)
      .eq('outcome', 'ok')
      .gte('created_at', since)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const rows = ((data ?? []) as CallRow[]).filter(
      (r) => typeof r.operation_key === 'string'
    );
    if (rows.length === 0) return [];

    // Catálogo global (waiver de n13.1): por id.
    const ids = [...new Set(rows.map((r) => r.integration_id))];
    const { data: integ, error: integError } = await db
      .from('integrations')
      .select('id, slug')
      .in('id', ids);
    if (integError) throw integError;
    const slugOf = new Map(
      ((integ ?? []) as { id: string; slug: string }[]).map((i) => [
        i.id,
        i.slug,
      ])
    );
    const out: PriorEvidence[] = [];
    for (const row of rows) {
      const slug = slugOf.get(row.integration_id);
      if (!slug) continue;
      out.push({ integrationSlug: slug, operationKey: row.operation_key! });
    }
    return out;
  } catch {
    console.error(
      '[ai tools] could not load prior evidence for account',
      accountId
    );
    return [];
  }
}
