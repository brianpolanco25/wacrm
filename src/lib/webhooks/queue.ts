// ============================================================
// Cola duradera de entregas de webhook (fase 7 §4).
//
// Antes de esto la entrega era «a lo sumo una vez»: un intento dentro
// de `after()` y, si el receptor estaba caído, el evento se perdía.
// Ahora cada evento se PERSISTE (una fila de `webhook_deliveries` por
// endpoint suscrito) antes de intentar nada, se intenta una vez en
// caliente y, si falla, queda con `next_attempt_at` en la escalera de
// S-A6 para que la drene `GET /api/webhooks/cron`.
//
// Garantía: **al menos una vez**. El mismo sobre (mismo `payload.id`)
// puede llegar repetido si el receptor responde 200 tarde o si acepta
// y luego corta; el receptor deduplica por `id`. La firma cambia en
// cada intento porque lleva el reloj del intento — es lo correcto:
// la tolerancia de `verifySignatureHeader` es antirrepetición, no una
// huella del contenido.
//
// Lo que NO hace: no reordena. Si a un endpoint le fallan dos eventos
// seguidos, el reintento del primero puede llegar después del segundo.
// El sobre lleva `occurred_at` para que el receptor ordene.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

/** Tiempo máximo por intento. Corto: el primero corre en `after()`. */
export const DELIVERY_TIMEOUT_MS = 5000;

/** Fallos CONSECUTIVOS del endpoint tras los que se autodesactiva (028). */
export const MAX_CONSECUTIVE_FAILURES = 15;

/**
 * Escalera de reintentos de S-A6: 1 min, 5 min, 30 min, 2 h, 12 h.
 * Son cinco REINTENTOS, así que con el intento inicial son seis
 * intentos por entrega antes de `dead` (ver `backoffMsForAttempt`).
 */
export const RETRY_BACKOFF_MS = [
  60_000, // 1 min
  5 * 60_000, // 5 min
  30 * 60_000, // 30 min
  2 * 60 * 60_000, // 2 h
  12 * 60 * 60_000, // 12 h
] as const;

/** Intento inicial + los cinco reintentos de S-A6. */
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

/** Retención de la bitácora de entregas (S-A6). */
export const DELIVERY_RETENTION_DAYS = 30;

/** Cuántas filas vencidas mira un barrido antes de repartir. */
export const SWEEP_SCAN_LIMIT = 500;

/** Cuántas entrega como mucho un barrido. */
export const SWEEP_BATCH_LIMIT = 100;

/**
 * Cupo por cuenta en cada barrido (fase 5 §3). Sin él, una cuenta con
 * mil pendientes se come el lote entero y la cuenta de al lado, con una
 * sola entrega, espera al barrido siguiente.
 */
export const SWEEP_PER_ACCOUNT_LIMIT = 10;

/** Intentos HTTP simultáneos dentro de un barrido. */
export const SWEEP_CONCURRENCY = 10;

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

/** Sobre firmado que viaja en el cuerpo de la petición. */
export interface WebhookEnvelope {
  id: string;
  event: string;
  occurred_at: string;
  account_id: string;
  data: unknown;
}

export interface DeliveryRow {
  id: string;
  account_id: string;
  endpoint_id: string;
  event: string;
  payload: WebhookEnvelope;
  attempt: number;
  status: DeliveryStatus;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

/** Columnas que la API y el panel pueden devolver (el secreto no está aquí). */
export const DELIVERY_PUBLIC_COLUMNS =
  'id, endpoint_id, event, attempt, status, next_attempt_at, last_status_code, last_error, created_at, delivered_at';

/** Columnas que necesita el motor de entrega. */
const DELIVERY_WORK_COLUMNS = `${DELIVERY_PUBLIC_COLUMNS}, account_id, payload`;

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

/**
 * Espera antes del siguiente intento, dado el número de intentos YA
 * realizados (1 = acaba de fallar el primero). `null` significa que la
 * escalera se agotó: la entrega muere.
 */
export function backoffMsForAttempt(attempt: number): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  const index = Math.max(0, attempt - 1);
  return (
    RETRY_BACKOFF_MS[index] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]
  );
}

/** Sobre de un evento. `id` es lo que el receptor usa para deduplicar. */
export function buildEventEnvelope(
  accountId: string,
  event: string,
  data: unknown,
  now = new Date()
): WebhookEnvelope {
  return {
    id: randomUUID(),
    event,
    occurred_at: now.toISOString(),
    account_id: accountId,
    data,
  };
}

/**
 * Persiste una entrega por endpoint activo de `accountId` suscrito a
 * `event`. Devuelve las filas creadas (vacío si nadie escucha). Nunca
 * lanza: un problema de cola no puede tumbar al llamador de dominio.
 */
export async function enqueueWebhookDeliveries(
  db: SupabaseClient,
  accountId: string,
  event: string,
  data: unknown
): Promise<DeliveryRow[]> {
  try {
    const { data: endpoints, error } = await db
      .from('webhook_endpoints')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .contains('events', [event]);

    if (error) {
      console.error('[webhooks] endpoint lookup failed:', error);
      return [];
    }
    if (!endpoints || endpoints.length === 0) return [];

    const now = new Date().toISOString();
    const rows = (endpoints as { id: string }[]).map((endpoint) => ({
      account_id: accountId,
      endpoint_id: endpoint.id,
      event,
      // Un sobre por endpoint: cada receptor deduplica el suyo.
      payload: buildEventEnvelope(accountId, event, data),
      // Explícitos, no por DEFAULT de la tabla: el reclamo compara
      // `attempt` y el barrido filtra por `status`/`next_attempt_at`,
      // así que ninguno de los tres puede llegar indefinido.
      attempt: 0,
      status: 'pending' as const,
      next_attempt_at: now,
    }));

    const { data: inserted, error: insertError } = await db
      .from('webhook_deliveries')
      .insert(rows)
      .select(DELIVERY_WORK_COLUMNS);

    if (insertError) {
      console.error('[webhooks] enqueue failed:', insertError);
      return [];
    }
    return (inserted ?? []) as unknown as DeliveryRow[];
  } catch (err) {
    console.error('[webhooks] enqueue threw:', err);
    return [];
  }
}

/**
 * Encola una entrega suelta contra UN endpoint concreto, saltándose el
 * filtro de suscripción. Lo usa `POST /webhooks/{id}/test` (el evento
 * `ping` no es suscribible a propósito).
 */
export async function enqueueSingleDelivery(
  db: SupabaseClient,
  accountId: string,
  endpointId: string,
  event: string,
  data: unknown
): Promise<DeliveryRow | null> {
  const { data: inserted, error } = await db
    .from('webhook_deliveries')
    .insert({
      account_id: accountId,
      endpoint_id: endpointId,
      event,
      payload: buildEventEnvelope(accountId, event, data),
      attempt: 0,
      status: 'pending' as const,
      next_attempt_at: new Date().toISOString(),
    })
    .select(DELIVERY_WORK_COLUMNS)
    .single();

  if (error || !inserted) {
    console.error('[webhooks] single enqueue failed:', error);
    return null;
  }
  return inserted as unknown as DeliveryRow;
}

/**
 * Reclama una entrega para intentarla: `attempt` sube en un UPDATE
 * condicionado al valor que leímos. Dos barridos solapados no pueden
 * ganar el mismo reclamo, así que un receptor no ve el mismo intento
 * duplicado por culpa de un cron que se pisa a sí mismo.
 * Devuelve la fila reclamada (con `attempt` ya incrementado) o `null`.
 */
export async function claimDelivery(
  db: SupabaseClient,
  row: Pick<DeliveryRow, 'id' | 'attempt'>
): Promise<DeliveryRow | null> {
  const { data, error } = await db
    .from('webhook_deliveries')
    .update({ attempt: row.attempt + 1, status: 'pending' })
    .eq('id', row.id)
    .eq('attempt', row.attempt)
    .in('status', ['pending', 'failed'])
    .select(DELIVERY_WORK_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error('[webhooks] claim failed:', error);
    return null;
  }
  return (data as unknown as DeliveryRow | null) ?? null;
}

async function markDelivered(
  db: SupabaseClient,
  row: DeliveryRow,
  statusCode: number
): Promise<void> {
  await db
    .from('webhook_deliveries')
    .update({
      status: 'delivered',
      delivered_at: new Date().toISOString(),
      last_status_code: statusCode,
      last_error: null,
    })
    .eq('id', row.id);
}

/**
 * Anota un intento fallido: programa el siguiente según S-A6 o mata la
 * entrega si la escalera se agotó, y suma un fallo consecutivo al
 * endpoint (que se autodesactiva a los 15, migración 028).
 */
async function markFailed(
  db: SupabaseClient,
  row: DeliveryRow,
  statusCode: number | null,
  error: string
): Promise<DeliveryStatus> {
  const delay = backoffMsForAttempt(row.attempt);
  const status: DeliveryStatus = delay === null ? 'dead' : 'failed';

  await db
    .from('webhook_deliveries')
    .update({
      status,
      last_status_code: statusCode,
      // Acotado: `last_error` es texto de un tercero y acaba en el panel.
      last_error: error.slice(0, 500),
      next_attempt_at: new Date(Date.now() + (delay ?? 0)).toISOString(),
    })
    .eq('id', row.id);

  const { error: rpcError } = await db.rpc('record_webhook_failure', {
    endpoint_id: row.endpoint_id,
    max_failures: MAX_CONSECUTIVE_FAILURES,
  });
  if (rpcError) {
    console.error('[webhooks] record_webhook_failure failed:', rpcError);
  }

  return status;
}

/**
 * Intenta UNA entrega ya reclamada y deja el resultado en la fila.
 * Nunca lanza. Devuelve el estado en el que queda la entrega.
 */
export async function attemptDelivery(
  db: SupabaseClient,
  row: DeliveryRow
): Promise<DeliveryStatus> {
  try {
    const { data: endpoint, error } = await db
      .from('webhook_endpoints')
      .select('id, url, secret')
      .eq('id', row.endpoint_id)
      .eq('account_id', row.account_id)
      .maybeSingle();

    if (error) {
      return await markFailed(db, row, null, 'endpoint lookup failed');
    }
    if (!endpoint) {
      // El endpoint se borró entre el encolado y el intento: la entrega
      // no tiene destino posible, así que no gasta reintentos.
      await db
        .from('webhook_deliveries')
        .update({
          status: 'dead',
          last_error: 'endpoint no longer exists',
        })
        .eq('id', row.id);
      return 'dead';
    }

    const target = endpoint as EndpointRow;

    // SSRF EN CADA INTENTO, no solo al registrar: un dominio público
    // puede pasar a resolver a 10.x entre el alta y la entrega.
    if (!(await isDeliverableUrl(target.url))) {
      return await markFailed(
        db,
        row,
        null,
        'delivery target does not resolve to a public address'
      );
    }

    let secret: string;
    try {
      secret = decrypt(target.secret);
    } catch {
      return await markFailed(db, row, null, 'endpoint secret is unreadable');
    }

    const body = JSON.stringify(row.payload);
    const tsSeconds = Math.floor(Date.now() / 1000);

    let res: Response;
    try {
      res = await fetch(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wacrm-Event': row.event,
          'X-Wacrm-Webhook-Id': target.id,
          'X-Wacrm-Delivery-Id': row.id,
          'X-Wacrm-Attempt': String(row.attempt),
          'X-Wacrm-Signature': buildSignatureHeader(body, secret, tsSeconds),
        },
        body,
        // Sin seguir redirecciones: una URL pública podría rebotar por
        // 3xx a una dirección interna y saltarse la guarda de arriba.
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
    } catch (err) {
      return await markFailed(
        db,
        row,
        null,
        err instanceof Error ? err.message : 'network error'
      );
    }

    if (!res.ok) {
      return await markFailed(
        db,
        row,
        res.status,
        `endpoint responded ${res.status}`
      );
    }

    await markDelivered(db, row, res.status);
    await db
      .from('webhook_endpoints')
      .update({ failure_count: 0, last_delivery_at: new Date().toISOString() })
      .eq('id', target.id)
      .eq('account_id', row.account_id);
    return 'delivered';
  } catch (err) {
    console.error('[webhooks] attempt threw:', err);
    try {
      return await markFailed(db, row, null, 'unexpected delivery error');
    } catch {
      return 'failed';
    }
  }
}

/** Reclama e intenta una entrega. `null` si otro barrido se la llevó. */
export async function claimAndAttempt(
  db: SupabaseClient,
  row: Pick<DeliveryRow, 'id' | 'attempt'>
): Promise<DeliveryStatus | null> {
  const claimed = await claimDelivery(db, row);
  if (!claimed) return null;
  return attemptDelivery(db, claimed);
}

/**
 * Reparte un lote entre cuentas por turnos: primera entrega de cada
 * cuenta, luego la segunda de cada una, etc. Una cuenta con mil
 * pendientes se lleva `perAccount` como mucho y la que tiene una sola
 * entra en la primera vuelta.
 */
export function selectFairBatch<T extends { account_id: string }>(
  rows: T[],
  opts: { perAccount: number; total: number }
): T[] {
  const queues = new Map<string, T[]>();
  for (const row of rows) {
    const queue = queues.get(row.account_id);
    if (queue) queue.push(row);
    else queues.set(row.account_id, [row]);
  }

  const out: T[] = [];
  for (let round = 0; round < opts.perAccount; round++) {
    let addedThisRound = false;
    for (const queue of queues.values()) {
      if (out.length >= opts.total) return out;
      const row = queue[round];
      if (!row) continue;
      out.push(row);
      addedThisRound = true;
    }
    if (!addedThisRound) break;
  }
  return out;
}

/** Ejecuta `task` sobre `items` con concurrencia acotada. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.allSettled(items.slice(i, i + limit).map(task));
  }
}

export interface SweepResult {
  scanned: number;
  attempted: number;
  delivered: number;
  failed: number;
  dead: number;
  skipped: number;
}

/**
 * Drena lo vencido con cupo por cuenta. Nunca lanza: el cron responde
 * con lo que consiguió hacer.
 */
export async function sweepDueDeliveries(
  db: SupabaseClient,
  opts?: {
    scanLimit?: number;
    batchLimit?: number;
    perAccountLimit?: number;
    concurrency?: number;
  }
): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    attempted: 0,
    delivered: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
  };

  const { data, error } = await db
    .from('webhook_deliveries')
    .select('id, account_id, attempt')
    .in('status', ['pending', 'failed'])
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(opts?.scanLimit ?? SWEEP_SCAN_LIMIT);

  if (error) {
    console.error('[webhooks] sweep scan failed:', error);
    return result;
  }

  const due = (data ?? []) as {
    id: string;
    account_id: string;
    attempt: number;
  }[];
  result.scanned = due.length;
  if (due.length === 0) return result;

  const batch = selectFairBatch(due, {
    perAccount: opts?.perAccountLimit ?? SWEEP_PER_ACCOUNT_LIMIT,
    total: opts?.batchLimit ?? SWEEP_BATCH_LIMIT,
  });

  await mapWithConcurrency(
    batch,
    opts?.concurrency ?? SWEEP_CONCURRENCY,
    async (row) => {
      const status = await claimAndAttempt(db, row);
      if (status === null) {
        result.skipped++;
        return;
      }
      result.attempted++;
      if (status === 'delivered') result.delivered++;
      else if (status === 'dead') result.dead++;
      else result.failed++;
    }
  );

  return result;
}

/**
 * Borra la bitácora de entregas más vieja que la retención (S-A6).
 * Devuelve cuántas filas cayeron.
 */
export async function purgeOldDeliveries(
  db: SupabaseClient,
  retentionDays = DELIVERY_RETENTION_DAYS
): Promise<number> {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await db
    .from('webhook_deliveries')
    .delete()
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    console.error('[webhooks] purge failed:', error);
    return 0;
  }
  return (data ?? []).length;
}
