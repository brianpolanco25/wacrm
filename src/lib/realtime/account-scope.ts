/**
 * Account scoping for Realtime subscriptions.
 *
 * Every `postgres_changes` subscription in this panel used to rely on
 * RLS to decide which rows it was allowed to hear about — the same
 * assumption the browser's `select()` calls made, and the same one
 * migration 057 ended. A platform operator with an open support session
 * passes `is_account_member(acc) OR has_open_support_session(acc)`, so
 * the replication stream hands their OWN company's rows to a tab that is
 * showing the customer's: a conversation of the operator's company drops
 * into the customer's inbox live, and the unread badge counts both.
 *
 * Two belts, because neither alone is enough:
 *
 *   1. `filter: account_id=eq.<id>` on the subscription — the server
 *      drops the event before it reaches the socket. Cheap and the real
 *      fix, but it is silently useless on DELETE for tables without
 *      `REPLICA IDENTITY FULL` (the old record carries only the primary
 *      key, so there is no `account_id` to match on).
 *   2. this check in the handler — the row the event carries has to name
 *      the account the tab is showing, or it never reaches state.
 *
 * Tables with no `account_id` column of their own (`messages`,
 * `message_reactions`) cannot use either: they reach the account through
 * their parent, and so does the code that consumes their events.
 */

/**
 * True when `row` carries exactly the account this browser is showing.
 *
 * Fails closed on everything else: no account to compare against
 * (`accountId` null — loading, or a support flag that names no account),
 * a row with no `account_id` at all (a DELETE payload without
 * `REPLICA IDENTITY FULL`), or a row from another company.
 */
export function eventBelongsToAccount(
  row: unknown,
  accountId: string | null
): boolean {
  if (!accountId) return false;
  if (typeof row !== 'object' || row === null) return false;
  const value = (row as { account_id?: unknown }).account_id;
  return typeof value === 'string' && value === accountId;
}
