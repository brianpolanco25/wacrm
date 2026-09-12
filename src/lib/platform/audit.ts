// ============================================================
// The platform's own audit trail.
//
// One table for everything an operator does to a company that is not
// theirs: opening a support session (f4.4) and, since migration 058,
// suspending or reactivating an account by hand. `impersonation_log`
// keeps its name because renaming it would break the 055/057 assertions
// and `has_open_support_session`; what changed is the `action` column
// that tells the three apart.
//
// One table, not two, on purpose: "what has been done to this customer"
// is a single question, and an operator who has to remember to check a
// second place will eventually not.
//
// Service role, always: neither table has a client write policy (055),
// which is the whole point — an audit trail a tenant could write is not
// one.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';

/** Acts recorded here. Mirrors the CHECK of migration 058. */
export type PlatformAction = 'impersonation' | 'suspend' | 'reactivate';

/**
 * Minimum length of the `reason`, mirrored from the CHECK in migrations
 * 055 and 058.
 *
 * Re-exported from the impersonation module rather than redeclared, so
 * there is one number: a route that accepted a shorter reason than the
 * database does would turn a 400 into a 500 at the insert.
 */
export { MIN_REASON_LENGTH } from '@/lib/auth/impersonation';

export interface PlatformAuditEntry {
  id: string;
  action: PlatformAction;
  actorUserId: string;
  reason: string;
  at: string;
  endedAt: string | null;
  endedReason: string | null;
}

/**
 * Write one line of the trail. Returns false when it could not be
 * written.
 *
 * The callers that CHANGE something (suspend, reactivate) check the
 * return value and refuse to act when it is false — an unrecorded
 * suspension is exactly the back door the spec calls out. Nothing is
 * swallowed here; the decision belongs to the caller.
 */
export async function recordPlatformAction(params: {
  action: Exclude<PlatformAction, 'impersonation'>;
  actorUserId: string;
  accountId: string;
  accountName: string | null;
  reason: string;
}): Promise<boolean> {
  const { error } = await supabaseAdmin().from('impersonation_log').insert({
    action: params.action,
    actor_user_id: params.actorUserId,
    account_id: params.accountId,
    // Snapshot, same reason as f4.4: the row outlives the account and a
    // bare uuid is unreadable six months later.
    account_name: params.accountName,
    reason: params.reason,
    // No window to expire: suspending is instantaneous, unlike a support
    // session. Migration 058 made `expires_at` nullable for exactly
    // these rows and kept it mandatory for sessions.
    expires_at: null,
  });

  if (error) {
    console.error('[platform/audit] could not record the action:', error);
    return false;
  }
  return true;
}

/**
 * Everything the platform has ever done to one account, newest first.
 *
 * Scoped by `account_id` — the filter this service-role read needs under
 * the repo's tenant rule (CP3), and the reason
 * `idx_impersonation_log_account` (055) exists.
 */
export async function loadAccountAudit(
  accountId: string,
  limit = 50
): Promise<PlatformAuditEntry[]> {
  const { data, error } = await supabaseAdmin()
    .from('impersonation_log')
    .select(
      'id, action, actor_user_id, reason, started_at, ended_at, ended_reason'
    )
    .eq('account_id', accountId)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[platform/audit] could not read the trail:', error);
    throw error;
  }

  return ((data as Record<string, unknown>[]) ?? []).map((row) => ({
    id: row.id as string,
    action: (row.action as PlatformAction) ?? 'impersonation',
    actorUserId: row.actor_user_id as string,
    reason: (row.reason as string) ?? '',
    at: row.started_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
    endedReason: (row.ended_reason as string | null) ?? null,
  }));
}
