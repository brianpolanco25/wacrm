// ============================================================
// Cuota gratis de mensajes de servicio por número (p11.3).
//
// Desde el 2026-10-01 Meta regala 1.000 mensajes de servicio entregados
// por número y mes y cobra los siguientes (supuestos S-C1…S-C6 de
// `specs/service-cap-per-number/design.md`, sin verificar contra Meta).
// La cuenta elige qué hace la IA cuando un número los agota
// (`accounts.service_cap_action`, migración 080):
//
//   - `warn`     (por defecto) solo avisa en la bandeja y en Ajustes;
//   - `pause_ai` además la IA deja de responder sola desde ese número
//                hasta el día 1 del mes siguiente (UTC).
//
// Nunca bloquea lo entrante ni los envíos manuales (CP11): lo único que
// importa `isAiPausedByServiceCap` es `src/lib/ai/auto-reply.ts`.
//
// El conteo sale de `message_charges` (075) a través de
// `service_quota_usage` (080), que solo ejecuta `service_role`. Quien la
// llame pasa SIEMPRE el `account_id` de la sesión o del entrante (CP3).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { metaBillingOf } from '@/lib/whatsapp/payment-method';
import {
  resolveWhatsAppConfig,
  WhatsAppConfigError,
} from '@/lib/whatsapp/resolve-config';

/** S-C1. Si Meta cambia el regalo, se cambia aquí y en ningún otro sitio. */
export const SERVICE_FREE_TIER_PER_NUMBER = 1000;

export type ServiceCapAction = 'warn' | 'pause_ai';

export interface ServiceUsage {
  used: number;
  billable: number;
  exhausted: boolean;
}

/** Cualquier cosa que no sea exactamente `pause_ai` es `warn`. */
export function asServiceCapAction(v: unknown): ServiceCapAction {
  return v === 'pause_ai' ? 'pause_ai' : 'warn';
}

/**
 * S-C4. Mes natural en UTC: `monthStart` es el día 1 a las 00:00 UTC del
 * mes de `now`; `resetsAt`, el día 1 del mes siguiente.
 */
export function serviceMonthWindow(now: Date): {
  monthStart: Date;
  resetsAt: Date;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    monthStart: new Date(Date.UTC(y, m, 1)),
    // Date.UTC normaliza el mes 12 al enero del año siguiente.
    resetsAt: new Date(Date.UTC(y, m + 1, 1)),
  };
}

/**
 * R4, puro. Un número está agotado si entregó ya la cuota gratis o si
 * Meta ya cobra algún mensaje de servicio suyo este mes (`billable > 0`:
 * la prueba directa, que corrige un conteo que se queda corto).
 */
export function serviceCapState(
  row: { used: number; billable: number } | undefined
): ServiceUsage {
  const used = Math.max(0, Number(row?.used ?? 0) || 0);
  const billable = Math.max(0, Number(row?.billable ?? 0) || 0);
  return {
    used,
    billable,
    exhausted: used >= SERVICE_FREE_TIER_PER_NUMBER || billable > 0,
  };
}

/**
 * Conteo del mes de una cuenta, por `whatsapp_config_id`. Un número sin
 * fila no tiene mensajes de servicio este mes (`serviceCapState(undefined)`).
 * Lanza si la RPC resuelve con `{ error }`: cada llamador decide si eso
 * es un 500 (la ruta) o «sin pausa» (la IA).
 *
 * `db` debe ser el cliente de rol de servicio: la función no la ejecuta
 * nadie más (080).
 */
export async function loadServiceUsage(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date()
): Promise<Map<string, ServiceUsage>> {
  const { monthStart } = serviceMonthWindow(now);
  const { data, error } = await db.rpc('service_quota_usage', {
    p_account_id: accountId,
    p_since: monthStart.toISOString(),
  });
  if (error) {
    throw new Error(
      `service_quota_usage failed: ${error.message ?? 'unknown error'}`
    );
  }
  const map = new Map<string, ServiceUsage>();
  for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
    const id = raw.whatsapp_config_id;
    if (typeof id !== 'string' || !id) continue;
    map.set(
      id,
      serviceCapState({
        used: Number(raw.used ?? 0),
        billable: Number(raw.billable ?? 0),
      })
    );
  }
  return map;
}

/**
 * R9–R13. ¿Debe la IA callarse en esta conversación porque su número
 * agotó la cuota gratis y la cuenta eligió `pause_ai`?
 *
 * Salida temprana en este orden, para que el caso común (`warn`) cueste
 * una consulta y no toque `message_charges`:
 *   1. la acción de la cuenta no es `pause_ai` → no;
 *   2. la cuenta es `managed` (076) → no: paga a Meta vía Cabbity;
 *   3. el número de la conversación (sellado y de esta cuenta; si no, el
 *      que usaría el envío: por defecto, luego el más antiguo); sin
 *      número → no;
 *   4. ¿ese número está agotado este mes?
 *
 * Falla abierta (R11): cualquier error → `console.warn` y `false`. Un
 * fallo nuestro no deja a los clientes de la cuenta sin respuesta; lo
 * peor que pasa es alguna respuesta de más.
 *
 * Todas las lecturas filtran por la cuenta: `db` es el rol de servicio.
 */
export async function isAiPausedByServiceCap(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    sealedConfigId: string | null;
    now?: Date;
  }
): Promise<boolean> {
  const { accountId, sealedConfigId } = args;
  try {
    // 1. La acción de la cuenta.
    const { data: account, error: accountErr } = await db
      .from('accounts')
      .select('service_cap_action')
      .eq('id', accountId)
      .maybeSingle();
    if (accountErr) throw new Error(`accounts: ${accountErr.message}`);
    if (asServiceCapAction(account?.service_cap_action) !== 'pause_ai') {
      return false;
    }

    // 2. `managed` no tiene cuota gratis que cuidar.
    const { data: sub, error: subErr } = await db
      .from('subscriptions')
      .select('meta_billing')
      .eq('account_id', accountId)
      .maybeSingle();
    if (subErr) throw new Error(`subscriptions: ${subErr.message}`);
    if (metaBillingOf(sub as Record<string, unknown> | null) === 'managed') {
      return false;
    }

    // 3. El número de la conversación (R12).
    const configId = await resolveConversationNumber(db, {
      accountId,
      sealedConfigId,
    });
    if (!configId) return false;

    // 4. ¿Agotado este mes?
    const usage = await loadServiceUsage(db, accountId, args.now);
    return serviceCapState(usage.get(configId)).exhausted;
  } catch (err) {
    console.warn(
      `[service-cap] account ${accountId}: could not check the free service quota — the AI replies as usual:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * R12. `conversations.whatsapp_config_id` si sigue existiendo en ESTA
 * cuenta; si no, el número que usaría el envío (`resolveWhatsAppConfig`
 * sin token: por defecto, luego el más antiguo). Sin número → null.
 */
async function resolveConversationNumber(
  db: SupabaseClient,
  args: { accountId: string; sealedConfigId: string | null }
): Promise<string | null> {
  const { accountId, sealedConfigId } = args;
  if (sealedConfigId) {
    const { data, error } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('id', sealedConfigId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw new Error(`whatsapp_config: ${error.message}`);
    if (data?.id) return data.id as string;
  }
  try {
    // Sin `conversationId`: el sellado ya se miró arriba, y pasarlo solo
    // repetiría esa lectura. Cae al número por defecto y luego al más
    // antiguo, igual que un envío.
    const { row } = await resolveWhatsAppConfig(db, { accountId });
    return row.id ?? null;
  } catch (err) {
    if (err instanceof WhatsAppConfigError) return null;
    throw err;
  }
}
