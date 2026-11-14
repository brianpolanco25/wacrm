// ============================================================
// GET /api/v1/members — miembros de la cuenta (scope: members:read).
//
// Para que un integrador (Cabbity Health) empareje a sus usuarios con
// quien atiende en el CRM. Paginado por cursor como el resto de listas
// (`created_at desc, id desc`). El SELECT es explícito: solo el id del
// usuario, nombre, correo y rol. Nunca teléfonos, avatares, tokens ni
// nada de otra cuenta.
//
// `id` es `profiles.user_id` (el mismo que `assigned_agent_id` de las
// conversaciones), no el id de la fila de `profiles`: esa solo viaja
// dentro del cursor.
//
// Aislamiento: el cliente de la clave es de rol de servicio, así que el
// `.eq('account_id', …)` es lo único que separa cuentas.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'members:read');
    const { limit, cursor } = parseListParams(request);

    let query = ctx.supabase
      .from('profiles')
      .select('id, created_at, user_id, full_name, email, account_role')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/members] list error:', error);
      return fail('internal', 'Failed to list members', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{
        created_at: string;
        id: string;
        user_id: string;
        full_name: string | null;
        email: string | null;
        account_role: string;
      }>,
      limit
    );
    return okList(
      items.map((row) => ({
        id: row.user_id,
        full_name: row.full_name ?? '',
        email: row.email ?? '',
        role: row.account_role,
      })),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
