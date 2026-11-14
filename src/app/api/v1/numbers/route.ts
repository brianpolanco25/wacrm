// ============================================================
// GET /api/v1/numbers — números de WhatsApp conectados de la cuenta.
//
// Para que un integrador sepa qué `from` (el `phone_number_id` de
// `POST /api/v1/messages`) puede usar. Scope: `messages:send`, el mismo
// que el envío. Devuelve solo datos públicos del número: nunca el token
// de acceso ni ninguna columna cifrada (el SELECT es explícito).
//
// Aislamiento: el cliente de la clave es de rol de servicio, así que el
// `.eq('account_id', …)` es lo único que separa cuentas.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    const { data, error } = await ctx.supabase
      .from('whatsapp_config')
      .select(
        'phone_number_id, display_phone_number, verified_name, is_default'
      )
      .eq('account_id', ctx.accountId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) throw error;

    return ok(
      (data ?? []).map((row) => ({
        phone_number_id: row.phone_number_id as string,
        display_phone_number:
          (row.display_phone_number as string | null) ?? null,
        verified_name: (row.verified_name as string | null) ?? null,
        is_default: row.is_default === true,
      }))
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
