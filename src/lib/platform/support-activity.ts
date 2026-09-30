// ============================================================
// One account's support sessions and what was changed in each (s9.5).
//
// Sessions come from `impersonation_log` (action = 'impersonation'), the
// actions from `impersonation_actions` (migration 072): one row per
// mutating request that reached a route (`source = 'http'`) and one per
// row the operator's JWT wrote on this account (`source = 'db'`).
//
// Service role, and therefore scoped by hand (CP3): BOTH queries filter by
// the account id they are asked about, and the actions additionally by the
// ids of the sessions just read for that same account. An action of
// another company cannot come back through either filter.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';

/** Sessions one file shows, newest first. */
export const SESSION_LIMIT = 20;
/** Actions one file shows across those sessions, newest first. */
export const ACTION_LIMIT = 500;

export interface SupportActionEntry {
  id: string;
  method: string;
  path: string;
  status: number | null;
  source: 'http' | 'db';
  at: string;
}

export interface SupportSessionEntry {
  id: string;
  actorUserId: string;
  reason: string;
  startedAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  /** Still in force at the moment of the read. */
  open: boolean;
  actions: SupportActionEntry[];
}

export interface SupportActivity {
  sessions: SupportSessionEntry[];
  /** True when the action list hit `ACTION_LIMIT` and older ones are not shown. */
  truncated: boolean;
}

export async function loadSupportActivity(
  accountId: string,
  now: number = Date.now()
): Promise<SupportActivity> {
  const db = supabaseAdmin();

  const { data: sessionRows, error: sessionError } = await db
    .from('impersonation_log')
    .select(
      'id, actor_user_id, reason, started_at, expires_at, ended_at, ended_reason'
    )
    .eq('account_id', accountId)
    .eq('action', 'impersonation')
    .order('started_at', { ascending: false })
    .limit(SESSION_LIMIT);

  if (sessionError) {
    console.error('[platform/support] sessions read failed:', sessionError);
    throw sessionError;
  }

  const sessions = ((sessionRows as Record<string, unknown>[]) ?? []).map(
    (row): SupportSessionEntry => {
      const endedAt = (row.ended_at as string | null) ?? null;
      const expiresAt = (row.expires_at as string | null) ?? null;
      const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
      return {
        id: row.id as string,
        actorUserId: row.actor_user_id as string,
        reason: (row.reason as string) ?? '',
        startedAt: row.started_at as string,
        expiresAt,
        endedAt,
        endedReason: (row.ended_reason as string | null) ?? null,
        open: endedAt === null && Number.isFinite(expiry) && expiry > now,
        actions: [],
      };
    }
  );

  if (sessions.length === 0) return { sessions, truncated: false };

  const { data: actionRows, error: actionError } = await db
    .from('impersonation_actions')
    .select('id, log_id, method, path, status, source, occurred_at')
    .eq('account_id', accountId)
    .in(
      'log_id',
      sessions.map((s) => s.id)
    )
    .order('occurred_at', { ascending: false })
    .limit(ACTION_LIMIT);

  if (actionError) {
    console.error('[platform/support] actions read failed:', actionError);
    throw actionError;
  }

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rows = (actionRows as Record<string, unknown>[]) ?? [];
  for (const row of rows) {
    const session = byId.get(row.log_id as string);
    // Belt and braces: a row that does not belong to one of THIS account's
    // sessions is dropped, whatever the query returned.
    if (!session) continue;
    session.actions.push({
      id: row.id as string,
      method: row.method as string,
      path: row.path as string,
      status: typeof row.status === 'number' ? row.status : null,
      source: row.source === 'db' ? 'db' : 'http',
      at: row.occurred_at as string,
    });
  }

  return { sessions, truncated: rows.length >= ACTION_LIMIT };
}
