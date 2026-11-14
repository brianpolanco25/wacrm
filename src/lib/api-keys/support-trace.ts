// ============================================================
// API keys in a support session (human decision, 2026-11-14).
//
// The operator mints, rotates and revokes the customer's API key so the
// customer can be connected to Cabbity Health. `api_keys` stays closed to
// the operator's JWT at the RLS (migration 072 lists it as refused), so
// inside a session the routes use the service role instead, always scoped
// by `ctx.accountId` — the impersonated account, from the signed cookie.
//
// Every such write leaves a row in `impersonation_actions`, written BEFORE
// the write: `<path> · api_key.<action> · <prefix or id>`. The detail is
// the key's public prefix (or its uuid), never the key. If the trail
// cannot be saved the route answers 503 and writes nothing.
//
// Attribution without a migration: `created_by` is the operator's user id
// (it was already `ctx.userId`). The list route tells the dashboard which
// keys were minted by a platform admin (`created_by_support`), so the
// customer sees that support created it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AccountContext } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import { labelSupportAction } from '@/lib/auth/support-actions';
import type { SupportWriteMethod } from '@/lib/auth/support-scope';

export type ApiKeySupportAction =
  'api_key.create' | 'api_key.revoke' | 'api_key.rotate';

/**
 * The client the api-keys routes query with: the caller's RLS client, or
 * the service role inside a support session (RLS closes `api_keys` to it).
 * Every query through it filters `account_id` by hand.
 */
export function apiKeysDb(
  ctx: Pick<AccountContext, 'impersonation' | 'supabase'>
): SupabaseClient {
  return ctx.impersonation ? supabaseAdmin() : ctx.supabase;
}

/** Outside a support session does nothing; inside, records the action. */
export async function traceApiKeySupportAction(
  ctx: Pick<AccountContext, 'impersonation'>,
  input: {
    action: ApiKeySupportAction;
    method: SupportWriteMethod;
    path: string;
    detail: string;
  }
): Promise<void> {
  if (!ctx.impersonation) return;
  await labelSupportAction(ctx.impersonation, input);
}

/** Subset of `userIds` that belong to platform admins. */
export async function platformAdminIds(
  userIds: string[]
): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const { data } = await supabaseAdmin()
    .from('platform_admins')
    .select('user_id')
    .in('user_id', ids);
  return new Set((data ?? []).map((r: { user_id: string }) => r.user_id));
}
