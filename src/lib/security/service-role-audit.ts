/**
 * Audit of the query log produced by `fake-supabase.ts`: it turns "every
 * service-role query carries its account scope" from a thing reviewers
 * check by eye into a property the suite enforces on every test.
 *
 * The service role bypasses RLS, so a query issued through it is only
 * scoped if the scope is written in the query. This module walks the log
 * and reports every service-role entry (`rls === null`) that has none:
 *
 *   - reads / updates / deletes are scoped by a filter on `account_id`
 *     (or on `<relation>.account_id`, the dotted form PostgREST uses on
 *     an embed);
 *   - inserts and upserts are scoped by an `account_id` on every row
 *     they write, since a filter would say nothing about a new row;
 *   - tables that have no `account_id` column of their own (see
 *     `CHILD_TABLES`) are scoped by the parent key instead, which the
 *     caller must have resolved under its own account first;
 *   - `rpc()` is scoped by an `p_*account_id` argument.
 *
 * Anything else has to be named in a waiver with a written reason —
 * the tenant-resolving lookups (an API key hash, a Meta phone number
 * id) and the cron sweeps that deliberately run across accounts. A new
 * unscoped query on a covered route matches no waiver and fails.
 *
 * Test-support code: only `tenant-isolation.test.ts` imports it.
 */

import type { QueryLogEntry, Row } from './fake-supabase';

/**
 * Tables whose tenancy hangs off a parent row instead of their own
 * `account_id` column — migration 017 gave everything else the column
 * and scoped these through the parent in RLS (`messages` via
 * `conversations`, and so on). A service-role query on one of them is
 * scoped by the parent key, and it is the caller's job to have resolved
 * that parent under its own account.
 */
export const CHILD_TABLES: Record<string, string> = {
  messages: 'conversation_id',
  message_reactions: 'conversation_id',
  contact_tags: 'contact_id',
  flow_nodes: 'flow_id',
  automation_steps: 'automation_id',
  broadcast_recipients: 'broadcast_id',
  flow_run_events: 'flow_run_id',
};

/**
 * Tables whose own primary key is the account: on `accounts`, `id` IS
 * `account_id`, so filtering by it is the account scope.
 */
export const SELF_SCOPED_TABLES: Record<string, string> = {
  accounts: 'id',
};

/** A service-role query that is safe without an account filter, and why. */
export interface ScopeWaiver {
  /** Table name, or `rpc:<function>`. */
  table: string;
  /** Restrict the waiver to one operation. Omit to cover all of them. */
  op?: QueryLogEntry['op'];
  /**
   * Columns whose presence in the query makes it safe. Every one of them
   * must be filtered on. An empty list waives an unfiltered query — only
   * for the cross-account sweeps, and the reason has to say so.
   */
  by?: string[];
  /** Why this query is safe without an account filter. Required. */
  reason: string;
}

export interface ScopeViolation {
  entry: QueryLogEntry;
  message: string;
}

function filterColumns(entry: QueryLogEntry): string[] {
  return entry.filters
    .filter((f) => f.op === 'eq' || f.op === 'in' || f.op === 'is')
    .map((f) => f.column);
}

function hasAccountFilter(entry: QueryLogEntry): boolean {
  // `account_id` or the dotted `<embed>.account_id` PostgREST accepts.
  return filterColumns(entry).some(
    (c) => c === 'account_id' || c.endsWith('.account_id')
  );
}

function writesAccountId(payload: Row[] | undefined): boolean {
  return (
    payload !== undefined &&
    payload.length > 0 &&
    payload.every((r) => typeof r.account_id === 'string')
  );
}

function writesColumn(payload: Row[] | undefined, column: string): boolean {
  return (
    payload !== undefined &&
    payload.length > 0 &&
    payload.every((r) => r[column] !== undefined && r[column] !== null)
  );
}

function matchesWaiver(entry: QueryLogEntry, waiver: ScopeWaiver): boolean {
  if (waiver.table !== entry.table) return false;
  if (waiver.op && waiver.op !== entry.op) return false;
  const columns = filterColumns(entry);
  return (waiver.by ?? []).every((c) => columns.includes(c));
}

const WRITES = new Set<QueryLogEntry['op']>(['insert', 'upsert']);

/**
 * Every service-role query in `log` that carries no account scope and
 * matches no waiver. An empty array is the property holding.
 */
export function unscopedServiceRoleQueries(
  log: QueryLogEntry[],
  waivers: ScopeWaiver[] = []
): ScopeViolation[] {
  const out: ScopeViolation[] = [];

  for (const entry of log) {
    // The cookie-session client is covered by RLS, simulated by the fake
    // from migration 017 — a missing filter there is not a leak.
    if (entry.rls !== null) continue;

    if (entry.op === 'rpc') {
      const args = entry.args ?? {};
      const scoped = Object.entries(args).some(
        ([k, v]) => /account_id$/.test(k) && typeof v === 'string'
      );
      if (scoped) continue;
      if (waivers.some((w) => matchesWaiver(entry, w))) continue;
      out.push({
        entry,
        message: `${entry.table} called with no account argument (args: ${Object.keys(args).join(', ') || 'none'})`,
      });
      continue;
    }

    // The column that carries the scope on this table: its own
    // `account_id`, the parent key of a child table, or the primary key
    // of a table that IS the account.
    const child = CHILD_TABLES[entry.table] ?? SELF_SCOPED_TABLES[entry.table];
    const scoped = WRITES.has(entry.op)
      ? child
        ? writesColumn(entry.payload, child)
        : writesAccountId(entry.payload)
      : child
        ? filterColumns(entry).includes(child) || hasAccountFilter(entry)
        : hasAccountFilter(entry);
    if (scoped) continue;
    if (waivers.some((w) => matchesWaiver(entry, w))) continue;

    const shape = WRITES.has(entry.op)
      ? `rows: ${[...new Set((entry.payload ?? []).flatMap((r) => Object.keys(r)))].join(', ') || 'none'}`
      : `filters: ${filterColumns(entry).join(', ') || 'none'}`;
    out.push({
      entry,
      message: `${entry.op} on ${entry.table} without ${child ?? 'account_id'} (${shape})`,
    });
  }

  return out;
}
