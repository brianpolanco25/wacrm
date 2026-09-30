// ============================================================
// Writes to the plan catalogue from the platform panel (fase 9, s9.3).
//
// `plans` has no client write policy (041) and keeps it that way: the
// tenant reads the price list, the operator writes it here with the
// service role, behind `requirePlatformAdmin()` in the route. There is
// no delete: a plan with subscriptions cannot go (the FK from
// `subscriptions` is RESTRICT), and one without is simply unpublished
// with `is_public = false`.
//
// Isolation: `plans` has no account_id — it is the global catalogue.
// Every write here is keyed by the plan id; nothing is unfiltered.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';
import type { PlanWrite } from '@/lib/billing/plan-catalog';
import {
  loadPlatformPlan,
  PLAN_COLUMNS,
  toPlatformPlan,
  type PlanRow,
  type PlatformPlan,
} from '@/lib/billing/plan-sync';

export class PlanExistsError extends Error {
  constructor(id: string) {
    super(`A plan with id '${id}' already exists`);
    this.name = 'PlanExistsError';
  }
}

export async function createCatalogPlan(
  value: PlanWrite
): Promise<PlatformPlan> {
  const { data, error } = await supabaseAdmin()
    .from('plans')
    .insert(value)
    .select(PLAN_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: unknown }).code === '23505') {
      throw new PlanExistsError(String(value.id));
    }
    throw error;
  }
  // A new plan has no PayPal id and therefore no history.
  return toPlatformPlan(data as PlanRow, []);
}

/** Null when the plan does not exist. */
export async function updateCatalogPlan(
  id: string,
  value: PlanWrite
): Promise<PlatformPlan | null> {
  const { data, error } = await supabaseAdmin()
    .from('plans')
    .update(value)
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // Re-read with the history: a price edit changes the sync state.
  return loadPlatformPlan(id);
}
