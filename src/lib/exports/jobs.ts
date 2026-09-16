// ============================================================
// Encargos de exportación (fase 7 §5) — el camino asíncrono.
//
// El ciclo de vida completo de una fila de `export_jobs` vive aquí, y
// las rutas solo lo invocan:
//
//   POST /api/v1/exports  → createExportJob  (queued, 202 al cliente)
//                           after()          → processExportJob
//   GET  /api/webhooks/cron → sweepExportJobs (lo que se quedó a medias)
//                           → purgeExpiredExports (S-A6: 7 días)
//   GET  /api/v1/exports/{id} → signExportDownload (15 min, recién
//                               acuñada; NUNCA guardada en la fila)
//
// Por qué el primer intento corre en `after()` y aun así hay barrido
//   `after()` se ejecuta en el mismo proceso que atendió la petición.
//   Si ese proceso muere —un despliegue, un OOM, el límite de tiempo de
//   la plataforma— el encargo se queda en `queued` o en `running` sin
//   avanzar y nadie lo volvería a mirar. El barrido del cron de a7.4 es
//   el único programador que este despliegue tiene, así que es donde se
//   retoma. No comparte cupo con las entregas de webhook: construir un
//   export cuesta órdenes de magnitud más que un POST a un receptor, y
//   dejarlos competir por el mismo lote significaría que una cuenta
//   exportando su historial retrasa las notificaciones de todas las
//   demás. De ahí `EXPORT_SWEEP_*`, aparte de `SWEEP_*`.
//
// El reclamo es optimista, como el de `claimDelivery`
//   El UPDATE va condicionado a los valores que se leyeron (`status` y
//   `started_at`). Dos barridos solapados, o un barrido y el `after()`
//   de la propia petición, no pueden construir el mismo archivo dos
//   veces: exactamente uno gana el UPDATE y el otro no ve fila.
//
// La URL firmada no se persiste
//   `export_jobs` guarda `file_path` (una ruta dentro del bucket), no
//   una URL. Cada `GET /api/v1/exports/{id}` acuña una firma de 15
//   minutos y la devuelve una sola vez. Guardarla sería dejar una
//   credencial al portador en una tabla que cualquier miembro de la
//   cuenta puede leer, con la vida del registro y no la de la firma.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { badRequest } from '@/lib/api/v1/respond';
import { selectFairBatch } from '@/lib/webhooks/queue';
import {
  type ConversationFilters,
  type ExportFormat,
  ExportTooLargeError,
  buildConversationsDocument,
  exportContentType,
  exportExtension,
  isExportFormat,
  renderExport,
} from '@/lib/exports/conversations';

/** Bucket privado de la migración 063. */
export const EXPORTS_BUCKET = 'exports';

/** Vida de la URL firmada que devuelve `GET /api/v1/exports/{id}`. */
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/** Retención de archivos y filas (S-A6). */
export const EXPORT_RETENTION_DAYS = 7;

/**
 * Un `running` que lleva más de esto sin terminar se da por huérfano y
 * el barrido lo vuelve a tomar. Diez minutos: muy por encima de lo que
 * tarda un export dentro de `ASYNC_MESSAGE_LIMIT` y muy por debajo de
 * la retención, así que un job que se cayó se rehace el mismo día.
 */
export const EXPORT_STALE_MS = 10 * 60 * 1000;

/** Cuántos encargos pendientes mira un barrido. */
export const EXPORT_SWEEP_SCAN_LIMIT = 50;

/**
 * Cuántos construye. Cinco, no cien: cada uno lee miles de filas y
 * sube un archivo, y el barrido corre cada minuto.
 */
export const EXPORT_SWEEP_BATCH_LIMIT = 5;

/** Y como mucho uno por cuenta y barrido: el reparto justo de a7.4. */
export const EXPORT_SWEEP_PER_ACCOUNT_LIMIT = 1;

/** Los únicos `kind` que la API acepta hoy (CHECK de la 063). */
export const EXPORT_KINDS = ['conversations'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export type ExportJobStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * Columnas que la API devuelve. `file_path` NO está: es una ruta de un
 * bucket que solo el rol de servicio lee, y publicarla solo serviría
 * para invitar a adivinar otras. `account_id` tampoco: quien pregunta
 * ya sabe de qué cuenta es su clave.
 */
export const EXPORT_JOB_PUBLIC_COLUMNS =
  'id, kind, format, status, params, row_count, error, created_at, finished_at, expires_at';

/** Lo que el barrido necesita para reclamar, y nada más. */
const EXPORT_JOB_WORK_COLUMNS =
  'id, account_id, kind, format, status, params, started_at';

export interface ExportJobRow {
  id: string;
  account_id: string;
  kind: string;
  format: string;
  status: string;
  params: Record<string, unknown> | null;
  started_at?: string | null;
  file_path?: string | null;
}

export interface ApiExportJob {
  id: string;
  kind: string;
  format: string;
  status: ExportJobStatus;
  filters: Record<string, unknown>;
  row_count: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string;
}

/** Proyecta una fila al contrato público. */
export function serializeExportJob(row: Record<string, unknown>): ApiExportJob {
  return {
    id: String(row.id),
    kind: String(row.kind),
    format: String(row.format),
    status: row.status as ExportJobStatus,
    filters: (row.params as Record<string, unknown> | null) ?? {},
    row_count: (row.row_count as number | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: String(row.created_at),
    finished_at: (row.finished_at as string | null) ?? null,
    expires_at: String(row.expires_at),
  };
}

/** Type-narrow de `kind`. */
export function isExportKind(value: unknown): value is ExportKind {
  return (
    typeof value === 'string' &&
    (EXPORT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Valida el objeto `filters` del cuerpo y lo devuelve ya normalizado
 * (las claves que se guardan en `params`). Lanza `bad_request` con el
 * nombre del campo, como el resto de `/api/v1`.
 *
 * Campos desconocidos se ignoran en silencio (contrato de la fase 7):
 * lo que no se reconoce no acota nada, y guardarlo solo serviría para
 * que el barrido reconstruyera una consulta que nadie validó.
 */
export function parseExportFilters(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest("'filters' must be an object");
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, string> = {};

  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || input.status.trim() === '') {
      throw badRequest("'filters.status' must be a non-empty string");
    }
    out.status = input.status.trim();
  }
  if (input.contact_id !== undefined) {
    if (
      typeof input.contact_id !== 'string' ||
      input.contact_id.trim() === ''
    ) {
      throw badRequest("'filters.contact_id' must be a non-empty string");
    }
    out.contact_id = input.contact_id.trim();
  }
  for (const key of ['from', 'to'] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
      throw badRequest(`'filters.${key}' must be an ISO-8601 timestamp`);
    }
    out[key] = new Date(raw).toISOString();
  }
  return out;
}

/** `params` (columnas de la tabla) → filtros de la consulta. */
export function filtersFromParams(
  params: Record<string, unknown> | null | undefined
): ConversationFilters {
  const p = params ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    status: str(p.status),
    contactId: str(p.contact_id),
    from: str(p.from),
    to: str(p.to),
  };
}

/** Ruta del objeto dentro del bucket. Primer segmento: la cuenta. */
export function exportObjectPath(job: {
  id: string;
  account_id: string;
  format: string;
}): string {
  return `${job.account_id}/${job.id}.${exportExtension(job.format as ExportFormat)}`;
}

// ------------------------------------------------------------
// Alta
// ------------------------------------------------------------

export interface CreateExportJobInput {
  accountId: string;
  apiKeyId: string | null;
  kind: ExportKind;
  format: ExportFormat;
  filters: Record<string, string>;
}

/** Inserta el encargo en `queued` y devuelve la fila pública. */
export async function createExportJob(
  db: SupabaseClient,
  input: CreateExportJobInput
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from('export_jobs')
    .insert({
      account_id: input.accountId,
      api_key_id: input.apiKeyId,
      kind: input.kind,
      format: input.format,
      params: input.filters,
      status: 'queued',
    })
    .select(EXPORT_JOB_PUBLIC_COLUMNS)
    .single();

  if (error || !data) {
    console.error('[exports] create failed:', error?.message);
    return null;
  }
  return data as Record<string, unknown>;
}

// ------------------------------------------------------------
// Reclamo y construcción
// ------------------------------------------------------------

/**
 * Reclama un encargo para construirlo: pasa a `running` con
 * `started_at` de ahora, condicionado a los valores leídos. Devuelve la
 * fila reclamada o `null` si otro proceso se adelantó.
 */
export async function claimExportJob(
  db: SupabaseClient,
  row: {
    id: string;
    account_id: string;
    status: string;
    started_at?: string | null;
  }
): Promise<ExportJobRow | null> {
  let query = db
    .from('export_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('account_id', row.account_id)
    .eq('status', row.status);

  // El candado: solo gana quien vio el mismo `started_at` que sigue en
  // la fila. `queued` recién creado lo tiene NULL.
  query = row.started_at
    ? query.eq('started_at', row.started_at)
    : query.is('started_at', null);

  const { data, error } = await query
    .select(EXPORT_JOB_WORK_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error('[exports] claim failed:', error.message);
    return null;
  }
  return (data as unknown as ExportJobRow | null) ?? null;
}

async function markFailed(
  db: SupabaseClient,
  job: ExportJobRow,
  message: string
): Promise<void> {
  await db
    .from('export_jobs')
    .update({
      status: 'failed',
      error: message.slice(0, 500),
      finished_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('account_id', job.account_id);
}

/**
 * Construye el documento de un encargo YA RECLAMADO, lo sube al bucket
 * y cierra la fila. Nunca lanza: un fallo deja el job en `failed` con
 * un motivo publicable, que es lo que el cliente consulta.
 */
export async function runExportJob(
  db: SupabaseClient,
  job: ExportJobRow
): Promise<ExportJobStatus> {
  try {
    if (job.kind !== 'conversations') {
      await markFailed(db, job, `Unsupported export kind '${job.kind}'`);
      return 'failed';
    }

    const format = isExportFormat(job.format) ? job.format : 'json';
    const doc = await buildConversationsDocument(
      db,
      job.account_id,
      filtersFromParams(job.params)
    );
    const body = renderExport(doc, format);
    const path = exportObjectPath(job);

    const { error: upErr } = await db.storage
      .from(EXPORTS_BUCKET)
      .upload(path, body, {
        contentType: exportContentType(format),
        upsert: true,
      });
    if (upErr) {
      // El mensaje de Storage puede traer rutas internas: no sale.
      console.error('[exports] upload failed:', upErr.message);
      await markFailed(db, job, 'Could not store the export file');
      return 'failed';
    }

    const { error } = await db
      .from('export_jobs')
      .update({
        status: 'done',
        file_path: path,
        row_count: doc.message_count,
        error: null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('account_id', job.account_id);

    if (error) {
      console.error('[exports] finish failed:', error.message);
      await markFailed(db, job, 'Could not record the finished export');
      return 'failed';
    }
    return 'done';
  } catch (err) {
    // `ExportTooLargeError` lleva un texto pensado para el cliente
    // (dice cómo partir el export). Cualquier otra cosa es nuestra y se
    // queda en el log: el cliente ve una frase genérica, sin SQL.
    const message =
      err instanceof ExportTooLargeError
        ? err.message
        : 'The export could not be generated';
    if (!(err instanceof ExportTooLargeError)) {
      console.error('[exports] build threw:', err);
    }
    await markFailed(db, job, message).catch(() => {});
    return 'failed';
  }
}

/**
 * Reclama y construye. Es lo que corre en `after()` tras el 202 y lo
 * que el barrido invoca por cada fila del lote. Devuelve `null` si no
 * se pudo reclamar (alguien se adelantó).
 */
export async function processExportJob(
  db: SupabaseClient,
  row: {
    id: string;
    account_id: string;
    status: string;
    started_at?: string | null;
  }
): Promise<ExportJobStatus | null> {
  const claimed = await claimExportJob(db, row);
  if (!claimed) return null;
  return runExportJob(db, claimed);
}

// ------------------------------------------------------------
// Descarga
// ------------------------------------------------------------

export interface SignedDownload {
  url: string;
  expiresAt: string;
}

/**
 * Acuña una URL firmada para el archivo de un encargo terminado. No se
 * guarda en ningún sitio: se devuelve una vez y caduca a los 15 min.
 */
export async function signExportDownload(
  db: SupabaseClient,
  filePath: string,
  ttlSeconds = DOWNLOAD_URL_TTL_SECONDS
): Promise<SignedDownload | null> {
  const { data, error } = await db.storage
    .from(EXPORTS_BUCKET)
    .createSignedUrl(filePath, ttlSeconds);

  if (error || !data?.signedUrl) {
    console.error('[exports] sign failed:', error?.message);
    return null;
  }
  return {
    url: data.signedUrl,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}

// ------------------------------------------------------------
// Barrido y purga (cron de a7.4, cupo aparte)
// ------------------------------------------------------------

export interface ExportSweepResult {
  scanned: number;
  processed: number;
  done: number;
  failed: number;
  skipped: number;
}

/**
 * Retoma lo que se quedó a medias: `queued` que nadie tomó y `running`
 * cuyo proceso murió (`started_at` más viejo que {@link EXPORT_STALE_MS}).
 * Nunca lanza.
 */
export async function sweepExportJobs(
  db: SupabaseClient,
  opts?: {
    scanLimit?: number;
    batchLimit?: number;
    perAccountLimit?: number;
    staleMs?: number;
  }
): Promise<ExportSweepResult> {
  const result: ExportSweepResult = {
    scanned: 0,
    processed: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  };

  const staleBefore = new Date(
    Date.now() - (opts?.staleMs ?? EXPORT_STALE_MS)
  ).toISOString();

  const { data, error } = await db
    .from('export_jobs')
    .select('id, account_id, status, started_at')
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: true })
    .limit(opts?.scanLimit ?? EXPORT_SWEEP_SCAN_LIMIT);

  if (error) {
    console.error('[exports] sweep scan failed:', error.message);
    return result;
  }

  // El `running` fresco es un job que alguien está construyendo AHORA:
  // se descarta aquí y no en la consulta porque un `or(...)` sobre dos
  // columnas es más frágil que un filtro en memoria sobre 50 filas.
  const due = ((data ?? []) as unknown as ExportJobRow[]).filter(
    (row) =>
      row.status === 'queued' ||
      (row.started_at !== null &&
        row.started_at !== undefined &&
        row.started_at < staleBefore)
  );
  result.scanned = due.length;
  if (due.length === 0) return result;

  const batch = selectFairBatch(due, {
    perAccount: opts?.perAccountLimit ?? EXPORT_SWEEP_PER_ACCOUNT_LIMIT,
    total: opts?.batchLimit ?? EXPORT_SWEEP_BATCH_LIMIT,
  });

  // En serie, a diferencia del barrido de webhooks: cada export carga
  // su documento entero en memoria y diez a la vez es justo lo que no
  // queremos.
  for (const row of batch) {
    const status = await processExportJob(db, row);
    if (status === null) {
      result.skipped++;
      continue;
    }
    result.processed++;
    if (status === 'done') result.done++;
    else result.failed++;
  }

  return result;
}

/**
 * Borra los encargos caducados (S-A6: 7 días). Primero el objeto del
 * bucket y luego la fila: si el borrado del archivo falla, la fila
 * sobrevive y el siguiente barrido lo reintenta, que es mejor que
 * perder el rastro de un archivo que sigue ahí.
 */
export async function purgeExpiredExports(db: SupabaseClient): Promise<number> {
  const now = new Date().toISOString();

  const { data, error } = await db
    .from('export_jobs')
    .select('id, account_id, file_path')
    .lt('expires_at', now)
    .limit(200);

  if (error) {
    console.error('[exports] purge scan failed:', error.message);
    return 0;
  }

  const expired = (data ?? []) as unknown as ExportJobRow[];
  if (expired.length === 0) return 0;

  const paths = expired
    .map((row) => row.file_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);

  if (paths.length > 0) {
    const { error: rmErr } = await db.storage
      .from(EXPORTS_BUCKET)
      .remove(paths);
    if (rmErr) {
      console.error('[exports] purge remove failed:', rmErr.message);
      return 0;
    }
  }

  const { data: deleted, error: delErr } = await db
    .from('export_jobs')
    .delete()
    .in(
      'id',
      expired.map((row) => row.id)
    )
    .select('id');

  if (delErr) {
    console.error('[exports] purge delete failed:', delErr.message);
    return 0;
  }
  return (deleted ?? []).length;
}
