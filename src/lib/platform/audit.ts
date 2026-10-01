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

/** Acts recorded here. Mirrors the CHECK of migrations 058, 071 and 078. */
export type PlatformAction =
  | 'impersonation'
  | 'suspend'
  | 'reactivate'
  // s9.4 (migration 071): the panel creates things.
  | 'plan_override'
  | 'account_create'
  | 'member_invite'
  | 'operator_grant'
  | 'operator_revoke'
  // s10.4 (migration 078): an open statement settled from the file.
  | 'payment_confirmed'
  | 'statement_void';

/**
 * Acts that may be recorded with no account (migration 071,
 * `impersonation_log_account_required`): the company does not exist yet
 * when `account_create` is written, and the operator role sits above
 * every company. Everything else needs one.
 */
export type AccountlessPlatformAction = 'account_create';

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
  /** What the act needs to remember (071): plans, invited email… */
  details: Record<string, unknown> | null;
}

/**
 * Write one line of the trail. Returns the id of the row, or null when
 * it could not be written.
 *
 * The callers that CHANGE something (suspend, reactivate, assign a plan,
 * invite…) check the return value and refuse to act when it is null —
 * an unrecorded act is exactly the back door the spec calls out.
 * Nothing is swallowed here; the decision belongs to the caller.
 *
 * `accountId` is null only for `account_create` (the company does not
 * exist yet; see `attachAccountToAuditRow`). The operator grants and
 * revokes are written by their own SQL functions (migration 071), in the
 * same transaction as the act.
 */
export async function recordPlatformAction(
  params:
    | {
        action: Exclude<
          PlatformAction,
          | 'impersonation'
          | AccountlessPlatformAction
          | 'operator_grant'
          | 'operator_revoke'
        >;
        actorUserId: string;
        accountId: string;
        accountName: string | null;
        reason: string;
        details?: Record<string, unknown>;
      }
    | {
        action: AccountlessPlatformAction;
        actorUserId: string;
        accountId: null;
        accountName: string | null;
        reason: string;
        details?: Record<string, unknown>;
      }
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('impersonation_log')
    .insert({
      action: params.action,
      actor_user_id: params.actorUserId,
      account_id: params.accountId,
      // Snapshot, same reason as f4.4: the row outlives the account and a
      // bare uuid is unreadable six months later.
      account_name: params.accountName,
      reason: params.reason,
      // No window to expire: these acts are instantaneous, unlike a
      // support session. Migration 058 made `expires_at` nullable for
      // exactly these rows and kept it mandatory for sessions.
      expires_at: null,
      details: params.details ?? null,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[platform/audit] could not record the action:', error);
    return null;
  }
  return (data as { id: string }).id;
}

/**
 * Fill in the account of an `account_create` row once the company
 * exists. Only a row that has none yet — `.is('account_id', null)` — so
 * a line of the trail can be completed once and never re-pointed at
 * another company.
 */
export async function attachAccountToAuditRow(
  logId: string,
  accountId: string
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('impersonation_log')
    .update({ account_id: accountId })
    .eq('id', logId)
    .is('account_id', null);
  if (error) {
    // The act already happened and its row exists (with the email in
    // `details`); failing the whole request here would report as an
    // error something that did take place.
    console.error('[platform/audit] could not attach the account:', error);
  }
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
      'id, action, actor_user_id, reason, started_at, ended_at, ended_reason, details'
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
    details:
      row.details &&
      typeof row.details === 'object' &&
      !Array.isArray(row.details)
        ? (row.details as Record<string, unknown>)
        : null,
  }));
}
