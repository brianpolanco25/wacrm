/**
 * Punto de entrada de una conversación (migración 082).
 *
 * Cuando un cliente escribe desde un anuncio Click to WhatsApp (CTWA), el
 * mensaje entrante trae `referral` y Meta abre una ventana de 72 h en la
 * que no cobra los mensajes del negocio. Este módulo lee ese `referral`,
 * calcula la ventana y la guarda en `conversations` para que la bandeja
 * muestre «Ventana gratis hasta …» ANTES de responder.
 *
 * Supuestos de Meta SIN verificar (specs/free-entry-point-badge/design.md):
 *   - S-E1: `referral` es un objeto con `source_type` (`'ad'` | `'post'`),
 *     `source_id`, `source_url`, `headline`, `ctwa_clid`, …
 *   - S-E2: solo los anuncios abren la ventana gratis.
 *   - S-E3: la ventana dura 72 h desde el mensaje del cliente.
 *   - S-E5: `timestamp` son segundos Unix en una cadena.
 *
 * Ante la duda, NO se abre la ventana: una insignia «gratis» falsa le
 * cuesta dinero al cliente; una que falta solo le quita un aviso.
 *
 * Nada de esto puede tumbar el webhook (CP11): `parseReferral` y
 * `computeEntryPoint` no lanzan con ninguna entrada, y `recordEntryPoint`
 * registra el error y vuelve.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const FREE_WINDOW_HOURS = 72;
const FREE_WINDOW_MS = FREE_WINDOW_HOURS * 60 * 60 * 1000;

/** Cuánto puede adelantarse el reloj de Meta al nuestro antes de desconfiar. */
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;

/** Tope de cada cadena guardada del referral (R7). */
const MAX_REFERRAL_TEXT = 500;

export const ENTRY_POINT_SOURCES = [
  'ctwa_ad',
  'ctwa_organic',
  'ctwa_other',
] as const;
export type EntryPointSource = (typeof ENTRY_POINT_SOURCES)[number];

/** Orígenes que abren ventana gratis (S-E2). Solo anuncios. */
export const FREE_WINDOW_SOURCES: readonly EntryPointSource[] = ['ctwa_ad'];

/** Las únicas claves del referral que se guardan (R7). */
const REFERRAL_KEYS = [
  'source_type',
  'source_id',
  'source_url',
  'headline',
  'ctwa_clid',
] as const;
type ReferralKey = (typeof REFERRAL_KEYS)[number];

export interface ParsedReferral {
  source: EntryPointSource;
  /** Lista blanca de R7, cadenas de ≤ 500. */
  referral: Partial<Record<ReferralKey, string>>;
}

/**
 * R5–R7. `null` si `raw` no es un objeto plano (ausente, `null`, cadena,
 * número, array). Nunca lanza.
 */
export function parseReferral(raw: unknown): ParsedReferral | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  const referral: Partial<Record<ReferralKey, string>> = {};
  for (const key of REFERRAL_KEYS) {
    const value = obj[key];
    if (typeof value === 'string') {
      referral[key] = value.slice(0, MAX_REFERRAL_TEXT);
    }
  }

  const sourceType =
    typeof obj.source_type === 'string'
      ? obj.source_type.trim().toLowerCase()
      : '';
  const source: EntryPointSource =
    sourceType === 'ad'
      ? 'ctwa_ad'
      : sourceType === 'post'
        ? 'ctwa_organic'
        : 'ctwa_other';

  return { source, referral };
}

export interface EntryPoint {
  entry_point_source: EntryPointSource;
  /** ISO */
  entry_point_at: string;
  /** ISO, o `null` si no se abre ventana. */
  free_window_until: string | null;
  entry_point_referral: ParsedReferral['referral'];
}

/**
 * Segundos Unix válidos: entero finito ≥ 0 y no más de 5 min en el
 * futuro respecto a `nowMs`. Si no, `null`.
 */
function parseTimestampSeconds(
  timestamp: unknown,
  nowMs: number
): number | null {
  if (typeof timestamp !== 'string' && typeof timestamp !== 'number') {
    return null;
  }
  if (typeof timestamp === 'string' && timestamp.trim() === '') return null;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) return null;
  if (seconds < 0) return null;
  if (seconds > nowMs / 1000 + MAX_FUTURE_SKEW_SECONDS) return null;
  return seconds;
}

/** R8–R10. Puro: el reloj entra como argumento. Nunca lanza. */
export function computeEntryPoint(
  parsed: ParsedReferral,
  timestamp: unknown,
  nowMs: number
): EntryPoint {
  const seconds = parseTimestampSeconds(timestamp, nowMs);

  if (seconds === null) {
    // R10: hora de recepción y sin ventana.
    return {
      entry_point_source: parsed.source,
      entry_point_at: new Date(nowMs).toISOString(),
      free_window_until: null,
      entry_point_referral: parsed.referral,
    };
  }

  const atMs = seconds * 1000;
  const opensWindow = FREE_WINDOW_SOURCES.includes(parsed.source);
  return {
    entry_point_source: parsed.source,
    entry_point_at: new Date(atMs).toISOString(),
    // Justo en el límite del CHECK de la 082 (≤ entry_point_at + 72 h).
    free_window_until: opensWindow
      ? new Date(atMs + FREE_WINDOW_MS).toISOString()
      : null,
    entry_point_referral: parsed.referral,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * R11, R14, R16. Guarda el punto de entrada en la conversación. Nunca
 * lanza.
 *
 * Solo escribe si `previousAt` (lo que la conversación tenía al leerla)
 * es NULL o anterior a `ep.entry_point_at`: un entrante con referral más
 * viejo no pisa uno más nuevo. El `UPDATE` lleva además un filtro
 * optimista sobre ese valor leído (`.is(null)` o `.eq(previousAt)`), así
 * que si otro entrante lo cambió entretanto, este no escribe.
 *
 * Filtra siempre por `id` Y `account_id` (CP3): el cliente es de rol de
 * servicio y se salta RLS.
 */
export async function recordEntryPoint(
  admin: SupabaseClient,
  accountId: string,
  conversationId: string,
  previousAt: string | null,
  ep: EntryPoint
): Promise<void> {
  try {
    if (previousAt !== null) {
      const prevMs = Date.parse(previousAt);
      const nextMs = Date.parse(ep.entry_point_at);
      // Un valor previo ilegible se trata como «más nuevo»: no se pisa.
      if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs)) return;
      if (prevMs >= nextMs) return;
    }

    const query = admin
      .from('conversations')
      .update({
        entry_point_source: ep.entry_point_source,
        entry_point_at: ep.entry_point_at,
        free_window_until: ep.free_window_until,
        entry_point_referral: ep.entry_point_referral,
      })
      .eq('id', conversationId)
      .eq('account_id', accountId);

    const { error } =
      previousAt === null
        ? await query.is('entry_point_at', null)
        : await query.eq('entry_point_at', previousAt);

    if (error) {
      console.error('[webhook] entry point update failed:', error.message);
    }
  } catch (err) {
    console.error('[webhook] entry point update failed:', errorMessage(err));
  }
}
