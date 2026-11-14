// ============================================================
// Pertenencia de un usuario a una cuenta, para asignar conversaciones.
//
// `assigned_agent_id` es un id de `auth.users` (`profiles.user_id`), y la
// FK de la migración 040 solo comprueba que el usuario exista en algún
// sitio. Sin esta validación, alguien podría aparcar un chat en el uuid
// de un extraño y el webhook `conversation.assigned` lo anunciaría.
// La usan el panel (`PATCH /api/conversations/{id}`) y la API pública
// (`PATCH /api/v1/conversations/{id}`).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export type MemberCheck =
  | { ok: true; role: string | null }
  | { ok: false; reason: 'not_member' | 'viewer' | 'error' };

/**
 * Comprueba que `userId` es miembro de `accountId`. Con
 * `rejectViewer`, un miembro con rol `viewer` tampoco vale (la API
 * pública no deja asignar ni firmar mensajes a quien solo lee).
 */
export async function checkAccountMember(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  opts: { rejectViewer?: boolean } = {}
): Promise<MemberCheck> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id, account_role')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    console.error('[conversations] member lookup:', error);
    return { ok: false, reason: 'error' };
  }
  if (!data) return { ok: false, reason: 'not_member' };

  const role = (data as { account_role?: string | null }).account_role ?? null;
  if (opts.rejectViewer && role === 'viewer') {
    return { ok: false, reason: 'viewer' };
  }
  return { ok: true, role };
}
