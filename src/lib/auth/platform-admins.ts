// ============================================================
// Membership of `platform_admins` — the operator of the service, the
// account-less role that sits above every company.
//
// Split out of `platform.ts` (the request guard) so `account.ts` can ask
// "is this user a platform admin?" while resolving a support session
// without importing the guard, which imports `account.ts` back. One
// question, one module, no cycle.
//
// The lookup runs through the SERVICE ROLE on purpose. `platform_admins`
// is readable from the client only by platform admins themselves
// (migration 055), so a session-client read would be a circular question:
// the answer for a non-admin — zero rows — is indistinguishable from "the
// policy hid it". The service role reads the fact directly, filtered by
// the caller's own `user_id`, which is never taken from the request body.
// ============================================================

import { supabaseAdmin } from './admin-client';

export interface PlatformAdmin {
  userId: string;
  grantedAt: string | null;
  note: string | null;
}

/**
 * The `platform_admins` row for `userId`, or `null` if there is none.
 *
 * Fails CLOSED: a database error returns `null` (not an exception), so a
 * degraded database cannot be the reason someone gets platform powers.
 * The error is logged — a silent "no" here would be hard to diagnose.
 */
export async function findPlatformAdmin(
  userId: string
): Promise<PlatformAdmin | null> {
  const { data, error } = await supabaseAdmin()
    .from('platform_admins')
    .select('user_id, granted_at, note')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[findPlatformAdmin] lookup failed:', error);
    return null;
  }
  if (!data) return null;

  return {
    userId: data.user_id as string,
    grantedAt: (data.granted_at as string | null) ?? null,
    note: (data.note as string | null) ?? null,
  };
}

/** True iff `userId` has a row in `platform_admins`. */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  return (await findPlatformAdmin(userId)) !== null;
}
