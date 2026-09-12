// ============================================================
// "Make this the default number" — the two writes, in the only order
// migration 053's partial unique index accepts.
//
// `whatsapp_config_one_default_per_account` is UNIQUE(account_id)
// WHERE is_default. Marking the new default BEFORE clearing the old one
// puts two `is_default` rows in the same account for an instant and the
// index rejects it. So: clear first, then mark. In between, the account
// has no default for a few milliseconds — harmless, because a send in
// that window falls to step 4 of the resolver (the oldest surviving
// row) instead of failing.
//
// Shared by POST /api/whatsapp/config and PATCH /api/whatsapp/config/[id]
// so the order can't drift between them.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Make `configId` the account's default number. Returns false when
 * either write failed; the caller turns that into a 500.
 *
 * Both statements carry `account_id` — with the service-role client
 * (which bypasses RLS) an id alone would let one tenant re-point
 * another tenant's default.
 */
export async function promoteDefault(
  db: SupabaseClient,
  accountId: string,
  configId: string
): Promise<boolean> {
  const { error: clearError } = await db
    .from('whatsapp_config')
    .update({ is_default: false })
    .eq('account_id', accountId)
    .eq('is_default', true);
  if (clearError) {
    console.error(
      '[default-number] clearing the old default failed:',
      clearError
    );
    return false;
  }

  const { data, error: setError } = await db
    .from('whatsapp_config')
    .update({ is_default: true })
    .eq('id', configId)
    .eq('account_id', accountId)
    .select('id');
  if (setError || !data || data.length === 0) {
    console.error('[default-number] setting the new default failed:', setError);
    return false;
  }
  return true;
}
