// ============================================================
// Server-side guard for the platform operator's routes.
//
// Same calling convention as `requireRole` (see `account.ts`): resolve or
// throw, and let one `catch` map the typed error to a status.
//
//   try {
//     const ctx = await requirePlatformAdmin();
//   } catch (err) {
//     return toErrorResponse(err); // 401 / 403
//   }
//
// The check is deliberately NOT a role comparison. `account_role_enum`
// answers "what may this person do inside their company"; nothing in it
// can answer "may this person act above every company", and reusing
// `owner` for that — which the spec forbids outright — would turn every
// mis-assigned company role into access to the whole service. The only
// thing that grants platform powers is a row in `platform_admins`, and
// that table has no write policy at all: it is administered with SQL
// against the database.
//
// Every route under `/api/platform/*` starts with this call. A user who
// is not in `platform_admins` — including an `owner`, including the owner
// of the very account being asked about — gets 403 and learns nothing
// else.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { ForbiddenError, UnauthorizedError } from './account';
import { findPlatformAdmin, type PlatformAdmin } from './platform-admins';

export interface PlatformContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` of the operator. */
  userId: string;
  /** Their `platform_admins` row. */
  admin: PlatformAdmin;
}

/**
 * Resolve the caller and require a `platform_admins` row.
 *
 * Throws `UnauthorizedError` (401) with no session, `ForbiddenError`
 * (403) for any authenticated user who is not a platform admin.
 */
export async function requirePlatformAdmin(): Promise<PlatformContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    throw new UnauthorizedError();
  }

  const admin = await findPlatformAdmin(user.id);
  if (!admin) {
    // Same message whatever the caller's company role is. "You are an
    // owner but not a platform admin" would confirm the route exists and
    // what it wants; there is nothing to gain by saying it.
    throw new ForbiddenError('Platform administrator access required');
  }

  return { supabase, userId: user.id, admin };
}
