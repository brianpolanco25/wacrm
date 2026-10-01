// ============================================================
// p11.1 — ¿tiene el WABA un método de pago en Meta?
//
// Desde el 2026-10-01 Meta deja de entregar los mensajes de un WABA sin
// método de pago (S-M6). El cliente que conectó su número por Embedded
// Signup paga a Meta directo, y hasta ahora el CRM no podía saber si
// tenía tarjeta: veía «Conectado» y sus mensajes no llegaban.
//
// Este módulo pregunta a Meta, guarda la respuesta en la fila de
// `whatsapp_config` (migración 079) y decide qué banner pinta el CRM.
// La pregunta se hace al conectar el número, desde el botón «Comprobar
// de nuevo» y en el barrido de `/api/webhooks/cron`; nunca en un render.
//
// SUPUESTOS SIN VERIFICAR (S-M1…S-M8 en
// `specs/meta-payment-method-check/design.md`). El campo
// `primary_funding_id` del nodo WABA no está documentado en el repo, y
// Graph omite los campos que un token no puede ver: una ausencia podría
// ser un falso «sin método de pago». Por eso:
//
//   - solo un 2xx que trae el `id` pedido y nada en
//     `primary_funding_id` cuenta como `missing`; todo lo demás es
//     `unknown`, que no pinta banner rojo;
//   - `META_PAYMENT_CHECK_DISABLED=1` apaga todo (ninguna llamada a
//     Meta, ningún banner) si el humano comprueba que el supuesto es
//     falso.
//
// Nada de aquí lanza hacia fuera (CP11): un fallo de la comprobación
// deja `unknown` y el alta, el guardado manual y el cron siguen igual.
// Ni el webhook entrante ni los envíos leen estas columnas.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { getWabaFundingInfo } from '@/lib/whatsapp/meta-api';

export type MetaPaymentStatus = 'ok' | 'missing' | 'unknown';
export type MetaBilling = 'direct' | 'managed';
export type MetaPaymentBanner = 'missing' | 'unknown' | null;

/** S-M4, sin verificar. Único sitio con la URL. */
export const META_BILLING_HUB_URL =
  'https://business.facebook.com/billing_hub/payment_settings/';
export const PAYMENT_CHECK_TIMEOUT_MS = 5_000;
export const PAYMENT_SWEEP_LIMIT = 25;
/** Cada cuánto vuelve a mirar el barrido un número, según su último estado. */
export const PAYMENT_RECHECK_MS: Record<MetaPaymentStatus, number> = {
  missing: 60 * 60_000,
  unknown: 6 * 60 * 60_000,
  ok: 24 * 60 * 60_000,
};

const ERROR_MAX_LENGTH = 500;
/** Códigos de Meta que significan «este token no puede ver eso» (R5). */
const PERMISSION_ERROR_CODES = new Set([10, 100, 200]);

export interface PaymentCheckResult {
  status: MetaPaymentStatus;
  error: string | null;
}

export interface PaymentSweepResult {
  /** `false` con `META_PAYMENT_CHECK_DISABLED=1`. */
  enabled: boolean;
  /** Filas leídas. */
  scanned: number;
  /** Filas comprobadas contra Meta. */
  checked: number;
  ok: number;
  missing: number;
  unknown: number;
}

export function isPaymentCheckDisabled(): boolean {
  return process.env.META_PAYMENT_CHECK_DISABLED?.trim() === '1';
}

function isStatus(value: unknown): value is MetaPaymentStatus {
  return value === 'ok' || value === 'missing' || value === 'unknown';
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Unknown error';
  return message.slice(0, ERROR_MAX_LENGTH);
}

/**
 * Puro. R4. `body` es el JSON de una respuesta 2xx de Meta.
 *
 * Conservador a propósito (S-M2): `missing` exige que Meta haya
 * devuelto el mismo `id` que pedimos —prueba de que leyó el WABA— y
 * nada en `primary_funding_id`.
 */
export function classifyFundingResponse(
  wabaId: string,
  body: unknown
): MetaPaymentStatus {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'unknown';
  }
  const record = body as Record<string, unknown>;
  const funding = record.primary_funding_id;
  if (typeof funding === 'string' && funding.trim() !== '') return 'ok';
  if (record.id !== wabaId) return 'unknown';
  if (funding === undefined || funding === null || funding === '') {
    return 'missing';
  }
  // Un tipo que no esperamos (número, objeto): no sabemos leerlo.
  return 'unknown';
}

/**
 * Una llamada a Meta. Nunca lanza (R4–R6): cualquier excepción —HTTP no
 * 2xx, error de Meta, red, timeout de 5 s, JSON inválido— es `unknown`
 * con el mensaje de Meta truncado. Ni el token ni la URL llegan al log.
 */
export async function fetchWabaPaymentStatus(args: {
  wabaId: string;
  accessToken: string;
}): Promise<PaymentCheckResult> {
  try {
    const body = await getWabaFundingInfo({
      wabaId: args.wabaId,
      accessToken: args.accessToken,
      signal: AbortSignal.timeout(PAYMENT_CHECK_TIMEOUT_MS),
    });
    const status = classifyFundingResponse(args.wabaId, body);
    return {
      status,
      error:
        status === 'unknown'
          ? 'Meta answered without the WABA id or with an unexpected primary_funding_id.'
          : null,
    };
  } catch (err) {
    const message = errorMessage(err);
    const code = (err as { code?: unknown } | null)?.code;
    const status = (err as { status?: unknown } | null)?.status;
    const permission =
      (typeof code === 'number' && PERMISSION_ERROR_CODES.has(code)) ||
      status === 403;
    // Una sola línea por fila y comprobación (R5); solo el mensaje.
    console.warn(
      `[payment-method] ${permission ? 'permission denied' : 'check failed'}:`,
      message
    );
    return { status: 'unknown', error: message };
  }
}

/**
 * Escribe el resultado con rol de servicio. Filtra por `id` **y**
 * `account_id` (CP3): aunque un id se cruzara, la escritura no puede
 * caer en otra cuenta. Nunca lanza.
 */
export async function recordPaymentStatus(
  db: SupabaseClient,
  scope: { accountId: string; configId: string },
  result: PaymentCheckResult,
  now: Date = new Date()
): Promise<boolean> {
  try {
    const { error } = await db
      .from('whatsapp_config')
      .update({
        meta_payment_status: result.status,
        meta_payment_checked_at: now.toISOString(),
        meta_payment_error:
          result.status === 'unknown' && result.error
            ? result.error.slice(0, ERROR_MAX_LENGTH)
            : null,
      })
      .eq('id', scope.configId)
      .eq('account_id', scope.accountId);
    if (error) {
      console.error(
        `[payment-method] could not record status for config ${scope.configId}:`,
        error.message
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[payment-method] could not record status for config ${scope.configId}:`,
      errorMessage(err)
    );
    return false;
  }
}

/**
 * Lee la fila (`id` + `account_id`), descifra su token salvo que venga
 * `accessToken` en claro (el alta y el guardado manual lo acaban de
 * recibir), comprueba y guarda.
 *
 * `null` si la fila no existe en esa cuenta (R12: la ruta responde 404
 * sin haber llamado a Meta) o no tiene `waba_id`. Con el interruptor
 * puesto también `null`, sin leer nada. Nunca lanza.
 */
export async function checkAndRecordPaymentStatus(
  db: SupabaseClient,
  scope: { accountId: string; configId: string },
  opts: {
    accessToken?: string;
    now?: Date;
    check?: typeof fetchWabaPaymentStatus;
  } = {}
): Promise<(PaymentCheckResult & { checkedAt: string }) | null> {
  if (isPaymentCheckDisabled()) return null;
  try {
    const { data, error } = await db
      .from('whatsapp_config')
      .select('id, account_id, waba_id, access_token')
      .eq('id', scope.configId)
      .eq('account_id', scope.accountId)
      .maybeSingle();
    if (error) {
      console.error(
        `[payment-method] could not read config ${scope.configId}:`,
        error.message
      );
      return null;
    }
    const row = data as {
      waba_id: string | null;
      access_token: string | null;
    } | null;
    if (!row || !row.waba_id) return null;

    const now = opts.now ?? new Date();
    const accessToken = opts.accessToken;
    const final = await runCheck(
      row.waba_id,
      () => accessToken ?? decrypt(row.access_token ?? ''),
      opts.check ?? fetchWabaPaymentStatus
    );
    await recordPaymentStatus(db, scope, final, now);
    return { ...final, checkedAt: now.toISOString() };
  } catch (err) {
    console.error(
      `[payment-method] check failed for config ${scope.configId}:`,
      errorMessage(err)
    );
    return null;
  }
}

/** Descifra (si hace falta) y pregunta. Un token ilegible es `unknown`. */
async function runCheck(
  wabaId: string,
  token: () => string,
  check: typeof fetchWabaPaymentStatus
): Promise<PaymentCheckResult> {
  let accessToken: string;
  try {
    accessToken = token();
  } catch (err) {
    return { status: 'unknown', error: errorMessage(err) };
  }
  return check({ wabaId, accessToken });
}

interface SweepRow {
  id: string;
  account_id: string;
  waba_id: string;
  access_token: string;
  meta_payment_status: string | null;
  meta_payment_checked_at: string | null;
}

/** ¿Le toca al número según su último estado? NULL = nunca comprobado. */
export function isPaymentCheckDue(
  row: Pick<SweepRow, 'meta_payment_status' | 'meta_payment_checked_at'>,
  nowMs: number
): boolean {
  if (!row.meta_payment_checked_at || !isStatus(row.meta_payment_status)) {
    return true;
  }
  const checkedAt = Date.parse(row.meta_payment_checked_at);
  if (!Number.isFinite(checkedAt)) return true;
  return nowMs - checkedAt >= PAYMENT_RECHECK_MS[row.meta_payment_status];
}

/**
 * R9/R10. Barrido entre cuentas para el cron: como mucho `limit`
 * números conectados con WABA cuya comprobación venció, los más
 * antiguos primero (NULL antes). Corre en ambos modos: a diferencia de
 * la renovación de tokens no necesita el secreto de la app, solo el
 * token de la fila. Una fila que falla no para a las demás. Nunca lanza.
 */
export async function sweepPaymentStatus(
  db: SupabaseClient,
  opts: {
    now?: () => Date;
    limit?: number;
    check?: typeof fetchWabaPaymentStatus;
  } = {}
): Promise<PaymentSweepResult> {
  const result: PaymentSweepResult = {
    enabled: false,
    scanned: 0,
    checked: 0,
    ok: 0,
    missing: 0,
    unknown: 0,
  };
  if (isPaymentCheckDisabled()) return result;
  result.enabled = true;

  const nowFn = opts.now ?? (() => new Date());
  const now = nowFn();
  const nowMs = now.getTime();
  const check = opts.check ?? fetchWabaPaymentStatus;
  const cutoff = (status: MetaPaymentStatus) =>
    new Date(nowMs - PAYMENT_RECHECK_MS[status]).toISOString();

  let rows: SweepRow[];
  try {
    // Una cadencia por estado ya en la consulta: si solo se filtrara por
    // «hace más de 1 h», 25 números `ok` comprobados hace 2 h ocuparían
    // el lote y un `missing` vencido esperaría a que se agotaran.
    const { data, error } = await db
      .from('whatsapp_config')
      .select(
        'id, account_id, waba_id, access_token, meta_payment_status, meta_payment_checked_at'
      )
      .eq('status', 'connected')
      .not('waba_id', 'is', null)
      .or(
        [
          'meta_payment_checked_at.is.null',
          'meta_payment_status.is.null',
          `and(meta_payment_status.eq.missing,meta_payment_checked_at.lte.${cutoff('missing')})`,
          `and(meta_payment_status.eq.unknown,meta_payment_checked_at.lte.${cutoff('unknown')})`,
          `and(meta_payment_status.eq.ok,meta_payment_checked_at.lte.${cutoff('ok')})`,
        ].join(',')
      )
      .order('meta_payment_checked_at', { ascending: true, nullsFirst: true })
      .limit(opts.limit ?? PAYMENT_SWEEP_LIMIT);
    if (error) {
      console.error('[payment-method] sweep scan failed:', error.message);
      return result;
    }
    rows = (data ?? []) as unknown as SweepRow[];
  } catch (err) {
    console.error('[payment-method] sweep scan failed:', errorMessage(err));
    return result;
  }

  result.scanned = rows.length;
  for (const row of rows) {
    // Defensa: la consulta ya filtra, pero el JS es la regla escrita.
    if (!row.waba_id || !isPaymentCheckDue(row, nowMs)) continue;
    let outcome: PaymentCheckResult;
    try {
      outcome = await runCheck(
        row.waba_id,
        () => decrypt(row.access_token),
        check
      );
      await recordPaymentStatus(
        db,
        { accountId: row.account_id, configId: row.id },
        outcome,
        now
      );
    } catch (err) {
      // `check` por defecto no lanza; uno inyectado o un fallo raro sí
      // podría. Se cuenta como `unknown` y se sigue con la siguiente.
      console.error(
        `[payment-method] sweep failed for config ${row.id}:`,
        errorMessage(err)
      );
      outcome = { status: 'unknown', error: errorMessage(err) };
    }
    result.checked += 1;
    result[outcome.status] += 1;
  }
  return result;
}

/**
 * R18. `row` es la fila de `subscriptions` (o lo que se leyó de ella).
 * Sin columna, sin fila o con cualquier otro valor → `direct`.
 */
export function metaBillingOf(
  row: Record<string, unknown> | null | undefined
): MetaBilling {
  return row?.meta_billing === 'managed' ? 'managed' : 'direct';
}

/**
 * R15–R18, R23. Puro: qué aviso pinta el CRM.
 *
 *   - interruptor puesto o cuenta `managed` → nada;
 *   - algún número conectado `missing` → banner rojo con el contador;
 *   - si no, y en modo plataforma algún número de Embedded Signup está
 *     `unknown` → aviso suave. Los manuales en `unknown` (token propio
 *     sin permiso, R17/A7) no hacen ruido: su etiqueta en Ajustes basta.
 *
 * No lee ni devuelve nada de `readOnly`: el aviso es informativo y no
 * bloquea ningún envío (R23).
 */
export function metaPaymentBanner(
  rows: Array<{
    status: string;
    provisioned_via: string | null;
    meta_payment_status: string | null;
  }>,
  ctx: { metaBilling: MetaBilling; platformMode: boolean; disabled: boolean }
): { banner: MetaPaymentBanner; missingNumbers: number } {
  if (ctx.disabled || ctx.metaBilling === 'managed') {
    return { banner: null, missingNumbers: 0 };
  }
  const connected = rows.filter((r) => r.status === 'connected');
  const missingNumbers = connected.filter(
    (r) => r.meta_payment_status === 'missing'
  ).length;
  if (missingNumbers > 0) return { banner: 'missing', missingNumbers };
  const unknownEmbedded = connected.some(
    (r) =>
      r.meta_payment_status === 'unknown' &&
      r.provisioned_via === 'embedded_signup'
  );
  if (ctx.platformMode && unknownEmbedded) {
    return { banner: 'unknown', missingNumbers: 0 };
  }
  return { banner: null, missingNumbers: 0 };
}
