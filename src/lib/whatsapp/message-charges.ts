/**
 * Lo que Meta cobra por cada mensaje saliente (migración 075,
 * `message_charges`).
 *
 * Meta adjunta un objeto `pricing` a los webhooks de estado `sent` y
 * `delivered`:
 *
 *   {"billable":true,"pricing_model":"PMP","category":"marketing","type":"regular"}
 *
 * Este módulo lo valida y lo registra con la RPC `record_message_charge`,
 * que es la única vía de escritura: rellena lo que falta sin pisar con
 * NULL, nunca retrocede el estado y nunca toca la fila de otra cuenta.
 * Es la fuente del corte mensual (s10.4) y del panel de consumo (s10.5).
 *
 * Reglas:
 *   - La categoría se guarda TAL CUAL: Meta añade categorías
 *     (`marketing_lite`, `referral_conversion`, variantes con guion) y
 *     perder una sería perder algo que facturar. La lista de abajo es la
 *     conocida; lo que no está en ella se guarda igual y se avisa UNA vez
 *     por valor y proceso con `console.warn`.
 *   - Nada de esto puede tumbar el webhook (CP11): `recordMessageCharge`
 *     no lanza nunca, registra el error y sigue.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Categorías de precio que Meta documenta hoy. */
export const KNOWN_PRICING_CATEGORIES = [
  'service',
  'utility',
  'marketing',
  'authentication',
  'authentication_international',
] as const;

/** Tipos de precio del modelo por mensaje (PMP). */
export const KNOWN_PRICING_TYPES = [
  'regular',
  'free_customer_service',
  'free_entry_point',
] as const;

/** Tope defensivo para los textos que llegan de Meta. */
const MAX_PRICING_TEXT = 64;

/** Cuántos valores desconocidos distintos se recuerdan para no repetir el aviso. */
const MAX_WARNED_VALUES = 200;

/** El `pricing` de un estado, tal como lo manda Meta. */
export interface WhatsAppStatusPricing {
  billable?: unknown;
  pricing_model?: unknown;
  category?: unknown;
  type?: unknown;
}

/** El `pricing` ya validado, listo para la RPC. */
export interface ParsedPricing {
  category: string;
  billable: boolean | null;
  type: string | null;
  model: string | null;
}

const warnedValues = new Set<string>();

/** Solo para tests: olvida qué valores ya se avisaron. */
export function resetPricingWarningsForTests(): void {
  warnedValues.clear();
}

function warnOnce(kind: string, value: string): void {
  const key = `${kind}:${value}`;
  if (warnedValues.has(key)) return;
  if (warnedValues.size >= MAX_WARNED_VALUES) return;
  warnedValues.add(key);
  console.warn(
    `[message-charges] Meta sent an unknown pricing ${kind} "${value}"; stored as-is`
  );
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_PRICING_TEXT) return null;
  return trimmed;
}

/**
 * El `pricing` de un estado, validado. Null cuando no hay categoría
 * utilizable: sin categoría no hay nada que cobrar y no se inventa.
 * Los demás campos que no tengan la forma esperada quedan en null en vez
 * de descartar la categoría.
 */
export function parseStatusPricing(raw: unknown): ParsedPricing | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as WhatsAppStatusPricing;

  const category = cleanText(p.category);
  if (!category) return null;
  if (!(KNOWN_PRICING_CATEGORIES as readonly string[]).includes(category)) {
    warnOnce('category', category);
  }

  const type = cleanText(p.type);
  if (type && !(KNOWN_PRICING_TYPES as readonly string[]).includes(type)) {
    warnOnce('type', type);
  }

  return {
    category,
    billable: typeof p.billable === 'boolean' ? p.billable : null,
    type,
    model: cleanText(p.pricing_model),
  };
}

export interface MessageChargeInput {
  accountId: string;
  /** El número por el que llegó el estado: el que envió. */
  whatsappConfigId: string | null;
  wamid: string;
  status: string;
  /** Momento del estado según Meta (ISO). */
  eventAt: string;
  messageId: string | null;
  broadcastRecipientId: string | null;
  recipientPhone: string | null;
  pricing: ParsedPricing | null;
}

export type MessageChargeOutcome =
  'inserted' | 'updated' | 'skipped' | 'foreign' | 'error';

/**
 * Registra (o avanza) el cobro de un `wamid`. Con `pricing` crea la fila
 * si no existe; sin `pricing` solo avanza una que ya exista. No lanza
 * nunca: el webhook de estados tiene que seguir aunque esto falle.
 */
export async function recordMessageCharge(
  db: SupabaseClient,
  input: MessageChargeInput
): Promise<MessageChargeOutcome> {
  try {
    const { data, error } = await db.rpc('record_message_charge', {
      p_account_id: input.accountId,
      p_wamid: input.wamid,
      p_status: input.status,
      p_event_at: input.eventAt,
      p_whatsapp_config_id: input.whatsappConfigId,
      p_message_id: input.messageId,
      p_broadcast_recipient_id: input.broadcastRecipientId,
      p_recipient_phone: input.recipientPhone,
      p_pricing_category: input.pricing?.category ?? null,
      p_pricing_billable: input.pricing?.billable ?? null,
      p_pricing_type: input.pricing?.type ?? null,
      p_pricing_model: input.pricing?.model ?? null,
    });
    if (error) {
      console.error('[message-charges] record_message_charge failed:', error);
      return 'error';
    }
    if (data === 'foreign') {
      // El wamid ya está registrado en OTRA cuenta (Meta no garantiza
      // que sea único entre números, migración 009). No se toca.
      console.warn(
        '[message-charges] wamid already charged to another account; left untouched'
      );
    }
    return (data as MessageChargeOutcome) ?? 'skipped';
  } catch (err) {
    console.error('[message-charges] record_message_charge threw:', err);
    return 'error';
  }
}
