// ============================================================
// Conciliación con Meta (fase 10, s10.7).
//
// Dos piezas:
//
//   1. `sweepMetaReconciliation` — un barrido más de `GET /api/billing/cron`
//      (mismo secreto, sin cron nuevo). Para cada cuenta
//      `meta_billing = 'managed'` con un número conectado que tenga WABA y
//      token, como mucho una vez al día por WABA (por `fetched_at`; un
//      WABA que falló se reintenta en la pasada siguiente), pide a Graph
//      `pricing_analytics` del WABA —COST + VOLUME por PHONE y
//      PRICING_CATEGORY, granularidad diaria, desde el día 1 del mes
//      anterior (UTC) hasta ahora— y lo guarda en `meta_spend_snapshots`
//      (084): una fila por día, número y categoría. Cada bajada
//      REEMPLAZA lo que la cuenta tenía de ese WABA en la ventana (borra y
//      escribe): re-bajar nunca suma dos veces el mismo día.
//
//   2. `reconcileStatements` — para la ficha del superadmin: por cada
//      estado de cuenta, la suma de `cost_usd` de los días de su periodo
//      (por WABA y en total) y la diferencia con `statements.meta_cost_usd`
//      (lo que calculamos nosotros con `message_charges` y el tarifario).
//      Si no hay ninguna fila en el periodo: «sin dato de Meta».
//
// Meta advierte que ese COST es aproximado: la factura de Meta es la
// verdad y la diferencia se ajusta como línea manual en el siguiente
// estado de cuenta. Aquí no se ajusta nada, solo se muestra.
//
// SUPUESTO SIN VERIFICAR (sin red): la forma de la respuesta. Se asume
//
//   { "pricing_analytics": { "data": [ { "data_points": [
//       { "start": 1759276800, "end": 1759363200,
//         "phone_number": "18095550000", "pricing_category": "MARKETING",
//         "pricing_type": "REGULAR", "volume": 120, "cost": 8.88 } ] } ] },
//     "id": "<waba_id>" }
//
// `parsePricingAnalytics` es conservador: cualquier cosa que no tenga esa
// forma (falta `pricing_analytics`, un punto sin `cost` o sin `volume`, un
// número negativo, `end <= start`) invalida la respuesta ENTERA de ese
// WABA y no se guarda nada: falla hacia «sin snapshot», nunca hacia un
// costo inventado. Un `data` vacío (o sin puntos) es una respuesta válida
// «sin datos»: se guarda la marca `_none` del día (volumen y costo 0)
// para no volver a preguntar en el día y para que la ficha diga «Meta: 0».
//
// Nunca lanza fuera del barrido (CP11): un fallo de Meta, de la base o de
// un token ilegible cuenta en `failed` y el cron sigue. CP11: no toca
// ninguna tabla del entrante.
//
// El listado del barrido cruza cuentas a propósito (como el de los
// estados de cuenta); cada lectura y escritura posterior va filtrada por
// el `account_id` de la cuenta que se procesa.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { getWabaPricingAnalytics } from '@/lib/whatsapp/meta-api';

/** Como mucho una bajada por cuenta y día. */
export const RECONCILIATION_INTERVAL_MS = 24 * 60 * 60_000;
/** Cuentas que se bajan por pasada; el resto espera a la siguiente. */
export const RECONCILIATION_FETCH_LIMIT = 10;
/** Cuentas managed que se leen por pasada. */
export const RECONCILIATION_SCAN_LIMIT = 200;
export const RECONCILIATION_TIMEOUT_MS = 10_000;
/** Marca de «Meta respondió sin datos» (ver la cabecera de la 084). */
export const NO_DATA_CATEGORY = '_none';

const DAY_MS = 24 * 60 * 60_000;
const UPSERT_CHUNK = 500;
const PAGE_SIZE = 1000;
const ERROR_MAX_LENGTH = 300;

export interface ReconciliationSweep {
  /** Cuentas managed con al menos un número conectado con WABA y token. */
  scanned: number;
  /** Cuentas cuyos WABA pendientes se bajaron y guardaron sin error. */
  fetched: number;
  /** Todos sus WABA leídos hace menos de un día, o fuera del lote. */
  skipped: number;
  /** Algún WABA de la cuenta falló (Meta, respuesta rara, token, base). */
  failed: number;
}

export interface PricingPoint {
  start: number;
  end: number;
  phone: string | null;
  category: string;
  volume: number;
  cost: number;
  raw: Record<string, unknown>;
}

export type FetchPricingAnalytics = (args: {
  wabaId: string;
  accessToken: string;
  start: number;
  end: number;
  signal?: AbortSignal;
}) => Promise<unknown>;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, ERROR_MAX_LENGTH);
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message).slice(
      0,
      ERROR_MAX_LENGTH
    );
  }
  return String(err).slice(0, ERROR_MAX_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Número finito desde número o cadena numérica; `null` si no lo es. */
function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function digitsOf(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/** Ventana de la bajada: del día 1 del mes anterior (UTC) a ahora. */
export function reconciliationWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  return { start, end: now };
}

export function floorDayUtc(value: string | number | Date): number {
  const ms = new Date(value).getTime();
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * Puro. Lee la respuesta de `pricing_analytics`. `null` = respuesta rara
 * (no se guarda nada); `[]` = Meta respondió sin datos.
 */
export function parsePricingAnalytics(body: unknown): PricingPoint[] | null {
  if (!isRecord(body)) return null;
  const analytics = body.pricing_analytics;
  if (!isRecord(analytics)) return null;
  const data = analytics.data;
  if (!Array.isArray(data)) return null;

  const points: PricingPoint[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) return null;
    const dataPoints = entry.data_points;
    if (dataPoints === undefined) continue;
    if (!Array.isArray(dataPoints)) return null;
    for (const p of dataPoints) {
      if (!isRecord(p)) return null;
      const start = finite(p.start);
      const end = finite(p.end);
      const volume = finite(p.volume);
      const cost = finite(p.cost);
      const category =
        typeof p.pricing_category === 'string'
          ? p.pricing_category.trim().toLowerCase()
          : '';
      if (start === null || end === null || end <= start) return null;
      if (volume === null || volume < 0 || !Number.isInteger(volume)) {
        return null;
      }
      if (cost === null || cost < 0) return null;
      if (!category || category === NO_DATA_CATEGORY) return null;
      const phone =
        typeof p.phone_number === 'string' && digitsOf(p.phone_number)
          ? digitsOf(p.phone_number)
          : null;
      points.push({ start, end, phone, category, volume, cost, raw: p });
    }
  }
  return points;
}

export interface SnapshotRow {
  account_id: string;
  whatsapp_config_id: string | null;
  waba_id: string;
  period_start: string;
  period_end: string;
  category: string;
  volume: number;
  cost_usd: number;
  fetched_at: string;
  raw: Record<string, unknown>;
}

/**
 * Puro. Los puntos → filas de `meta_spend_snapshots`. El PHONE se casa
 * por dígitos con `display_phone_number` de los números de ESTA cuenta en
 * ese WABA; sin casar, `whatsapp_config_id = NULL`. Puntos con la misma
 * clave (p. ej. dos `pricing_type` del mismo día y categoría) se suman:
 * un upsert no puede tocar la misma fila dos veces.
 */
export function snapshotRows(args: {
  accountId: string;
  wabaId: string;
  points: PricingPoint[];
  configs: { id: string; display_phone_number: string | null }[];
  fetchedAt: string;
}): SnapshotRow[] {
  const byDigits = new Map<string, string>();
  for (const c of args.configs) {
    const d = digitsOf(c.display_phone_number);
    if (d) byDigits.set(d, c.id);
  }
  const rows = new Map<string, SnapshotRow & { _points: unknown[] }>();
  for (const p of args.points) {
    const configId = p.phone ? (byDigits.get(p.phone) ?? null) : null;
    const periodStart = new Date(p.start * 1000).toISOString();
    const periodEnd = new Date(p.end * 1000).toISOString();
    const key = [periodStart, periodEnd, p.category, configId ?? ''].join('|');
    const existing = rows.get(key);
    if (existing) {
      existing.volume += p.volume;
      existing.cost_usd += p.cost;
      existing._points.push(p.raw);
      continue;
    }
    rows.set(key, {
      account_id: args.accountId,
      whatsapp_config_id: configId,
      waba_id: args.wabaId,
      period_start: periodStart,
      period_end: periodEnd,
      category: p.category,
      volume: p.volume,
      cost_usd: p.cost,
      fetched_at: args.fetchedAt,
      raw: {},
      _points: [p.raw],
    });
  }
  return [...rows.values()].map(({ _points, ...row }) => ({
    ...row,
    cost_usd: Math.round(row.cost_usd * 1e6) / 1e6,
    raw: { points: _points },
  }));
}

/** La marca `_none` del día de `now`. */
export function noDataRow(args: {
  accountId: string;
  wabaId: string;
  now: Date;
}): SnapshotRow {
  const day = floorDayUtc(args.now);
  return {
    account_id: args.accountId,
    whatsapp_config_id: null,
    waba_id: args.wabaId,
    period_start: new Date(day).toISOString(),
    period_end: new Date(day + DAY_MS).toISOString(),
    category: NO_DATA_CATEGORY,
    volume: 0,
    cost_usd: 0,
    fetched_at: args.now.toISOString(),
    raw: { empty: true },
  };
}

const SNAPSHOT_CONFLICT =
  'account_id,waba_id,period_start,period_end,category,whatsapp_config_id';

interface ConfigRow {
  id: string;
  account_id: string;
  waba_id: string | null;
  access_token: string | null;
  display_phone_number: string | null;
}

/** Última bajada de un WABA de una cuenta (el gate es por cuenta+WABA). */
async function lastFetchedAt(
  db: SupabaseClient,
  accountId: string,
  wabaId: string
): Promise<number | null> {
  const { data, error } = await db
    .from('meta_spend_snapshots')
    .select('fetched_at')
    .eq('account_id', accountId)
    .eq('waba_id', wabaId)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const at = (data as { fetched_at?: string } | null)?.fetched_at;
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** Un WABA de una cuenta. `true` si se guardó; nunca lanza. */
async function fetchWaba(
  db: SupabaseClient,
  args: {
    accountId: string;
    wabaId: string;
    configs: ConfigRow[];
    now: Date;
    fetchAnalytics: FetchPricingAnalytics;
  }
): Promise<boolean> {
  const { accountId, wabaId, configs, now } = args;
  try {
    let accessToken: string | null = null;
    for (const c of configs) {
      try {
        const token = decrypt(c.access_token ?? '');
        if (token) {
          accessToken = token;
          break;
        }
      } catch {
        // ilegible: prueba con el siguiente número del mismo WABA
      }
    }
    if (!accessToken) {
      console.warn(
        `[meta-reconciliation] no readable token for WABA ${wabaId} (account ${accountId})`
      );
      return false;
    }

    const window = reconciliationWindow(now);
    const body = await args.fetchAnalytics({
      wabaId,
      accessToken,
      start: Math.floor(window.start.getTime() / 1000),
      end: Math.floor(window.end.getTime() / 1000),
      signal: AbortSignal.timeout(RECONCILIATION_TIMEOUT_MS),
    });
    const points = parsePricingAnalytics(body);
    if (points === null) {
      console.warn(
        `[meta-reconciliation] unexpected pricing_analytics shape for WABA ${wabaId} (account ${accountId}); nothing stored`
      );
      return false;
    }

    // Reemplaza, no suma: lo que esta cuenta guardó de este WABA en la
    // ventana pedida se borra antes de escribir lo que Meta dice ahora.
    // Si el casado PHONE → número cambió entre pasadas (número
    // desconectado, reconectado con otra fila, otro display), la fila
    // vieja con otro `whatsapp_config_id` no queda junto a la nueva.
    const { error: deleteErr } = await db
      .from('meta_spend_snapshots')
      .delete()
      .eq('account_id', accountId)
      .eq('waba_id', wabaId)
      .gte('period_start', window.start.toISOString())
      .lte('period_start', window.end.toISOString());
    if (deleteErr) throw deleteErr;

    const fetchedAt = now.toISOString();
    const rows =
      points.length > 0
        ? snapshotRows({ accountId, wabaId, points, configs, fetchedAt })
        : [noDataRow({ accountId, wabaId, now })];
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const { error } = await db
        .from('meta_spend_snapshots')
        .upsert(rows.slice(i, i + UPSERT_CHUNK), {
          onConflict: SNAPSHOT_CONFLICT,
        });
      if (error) throw error;
    }
    return true;
  } catch (err) {
    // Ni el token ni la URL llegan al log: solo el mensaje.
    console.warn(
      `[meta-reconciliation] WABA ${wabaId} (account ${accountId}) failed:`,
      errorMessage(err)
    );
    return false;
  }
}

/** Una pasada. Nunca lanza: lo que falla cuenta en `failed`. */
export async function sweepMetaReconciliation(
  db: SupabaseClient,
  opts: {
    now?: Date;
    fetchLimit?: number;
    fetchAnalytics?: FetchPricingAnalytics;
  } = {}
): Promise<ReconciliationSweep> {
  const summary: ReconciliationSweep = {
    scanned: 0,
    fetched: 0,
    skipped: 0,
    failed: 0,
  };
  const now = opts.now ?? new Date();
  const fetchLimit = opts.fetchLimit ?? RECONCILIATION_FETCH_LIMIT;
  const fetchAnalytics = opts.fetchAnalytics ?? getWabaPricingAnalytics;

  let byAccount: Map<string, Map<string, ConfigRow[]>>;
  try {
    // Cruza cuentas a propósito: el barrido. Lo de abajo va por cuenta.
    const { data: subs, error: subsErr } = await db
      .from('subscriptions')
      .select('account_id')
      .eq('meta_billing', 'managed')
      .order('account_id', { ascending: true })
      .limit(RECONCILIATION_SCAN_LIMIT);
    if (subsErr) throw subsErr;
    const accountIds = [
      ...new Set(
        ((subs ?? []) as { account_id: string }[]).map((s) => s.account_id)
      ),
    ];
    if (accountIds.length === 0) return summary;

    const { data: configs, error: configsErr } = await db
      .from('whatsapp_config')
      .select('id, account_id, waba_id, access_token, display_phone_number')
      .in('account_id', accountIds)
      .eq('status', 'connected')
      .not('waba_id', 'is', null);
    if (configsErr) throw configsErr;

    byAccount = new Map();
    const managed = new Set(accountIds);
    for (const c of (configs ?? []) as ConfigRow[]) {
      // Defensa: la consulta ya filtra, el JS es la regla escrita.
      if (!managed.has(c.account_id)) continue;
      const waba = c.waba_id?.trim();
      if (!waba || !c.access_token) continue;
      const wabas = byAccount.get(c.account_id) ?? new Map();
      wabas.set(waba, [...(wabas.get(waba) ?? []), c]);
      byAccount.set(c.account_id, wabas);
    }
  } catch (err) {
    console.error('[meta-reconciliation] scan failed:', errorMessage(err));
    return summary;
  }

  summary.scanned = byAccount.size;

  // ¿A quién le toca? El gate es por cuenta+WABA: un WABA que falló no
  // gana `fetched_at` y se reintenta en la pasada siguiente aunque otro
  // WABA de la misma cuenta se haya guardado. Una cuenta entra si alguno
  // de sus WABA toca; solo se piden esos. Los nunca bajados primero.
  const due: { accountId: string; wabas: string[]; last: number }[] = [];
  for (const [accountId, wabas] of byAccount) {
    try {
      const dueWabas: string[] = [];
      let oldest = Infinity;
      for (const wabaId of wabas.keys()) {
        const last = await lastFetchedAt(db, accountId, wabaId);
        if (
          last !== null &&
          now.getTime() - last < RECONCILIATION_INTERVAL_MS
        ) {
          continue;
        }
        dueWabas.push(wabaId);
        oldest = Math.min(oldest, last ?? -Infinity);
      }
      if (dueWabas.length === 0) {
        summary.skipped += 1;
        continue;
      }
      due.push({ accountId, wabas: dueWabas, last: oldest });
    } catch (err) {
      summary.failed += 1;
      console.warn(
        `[meta-reconciliation] could not read the last fetch of account ${accountId}:`,
        errorMessage(err)
      );
    }
  }
  due.sort((a, b) => a.last - b.last);

  for (const [i, { accountId, wabas }] of due.entries()) {
    if (i >= fetchLimit) {
      summary.skipped += 1;
      continue;
    }
    const byWaba = byAccount.get(accountId) ?? new Map<string, ConfigRow[]>();
    let ok = true;
    for (const wabaId of wabas) {
      const stored = await fetchWaba(db, {
        accountId,
        wabaId,
        configs: byWaba.get(wabaId) ?? [],
        now,
        fetchAnalytics,
      });
      if (!stored) ok = false;
    }
    if (ok) summary.fetched += 1;
    else summary.failed += 1;
  }
  return summary;
}

// ============================================================
// La ficha del superadmin
// ============================================================

export interface WabaReconciliation {
  wabaId: string;
  /**
   * Suma de `cost_usd` de Meta en el periodo, redondeada a centavos;
   * `null` = sin dato de ese WABA en el periodo.
   */
  metaReportedCostUsd: number | null;
  volume: number | null;
  /** Última bajada de ESTE WABA; `null` si nunca se bajó. */
  lastFetchedAt: string | null;
  /** Este WABA no se ha leído después del fin del periodo. */
  partial: boolean;
}

export interface StatementReconciliation {
  /** `null` = sin dato de Meta para ese periodo (ningún WABA). */
  metaReportedCostUsd: number | null;
  /** Nuestro `meta_cost_usd` − lo que reporta Meta; `null` sin dato. */
  differenceUsd: number | null;
  /** Mensajes que Meta reporta en el periodo; `null` sin dato. */
  volume: number | null;
  wabas: WabaReconciliation[];
  /**
   * La lectura más vieja entre los WABA del periodo; `null` si alguno no
   * se ha leído nunca.
   */
  lastFetchedAt: string | null;
  /** Algún WABA del periodo no se ha leído después de su fin. */
  partial: boolean;
}

/** Un WABA de la cuenta y su última bajada. */
export interface WabaReading {
  wabaId: string;
  lastFetchedAt: string | null;
  /** Hoy tiene un número conectado: cuenta aunque no tenga filas. */
  connected: boolean;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

interface SnapshotReadRow {
  waba_id: string;
  period_start: string;
  category: string;
  volume: number | string;
  cost_usd: number | string;
  fetched_at: string;
}

/**
 * Puro. Un día de Meta pertenece al estado cuyo
 * [día(period_start), día(period_end)) contiene su inicio: los periodos
 * anclados a media jornada se redondean al día UTC, así cada día cae en
 * un solo estado (hasta un día de desfase en cada borde, documentado).
 *
 * Los WABA del periodo son los que tienen filas en él y los que hoy
 * tienen un número conectado. Cada uno es `partial` si su última bajada
 * es anterior al fin del periodo (o no existe): un WABA que falló no se
 * esconde detrás de otro que sí se leyó.
 */
export function reconcileOne(
  statement: { periodStart: string; periodEnd: string; metaCostUsd: number },
  rows: SnapshotReadRow[],
  readings: WabaReading[]
): StatementReconciliation {
  const from = floorDayUtc(statement.periodStart);
  const to = floorDayUtc(statement.periodEnd);
  const end = Date.parse(statement.periodEnd);
  const inPeriod = rows.filter((r) => {
    const at = Date.parse(r.period_start);
    return Number.isFinite(at) && at >= from && at < to;
  });

  const byWaba = new Map<string, { cost: number; volume: number }>();
  for (const r of inPeriod) {
    const acc = byWaba.get(r.waba_id) ?? { cost: 0, volume: 0 };
    acc.cost += Number(r.cost_usd) || 0;
    if (r.category !== NO_DATA_CATEGORY) acc.volume += Number(r.volume) || 0;
    byWaba.set(r.waba_id, acc);
  }

  const lastOf = new Map(readings.map((r) => [r.wabaId, r.lastFetchedAt]));
  const relevant = new Set<string>([
    ...byWaba.keys(),
    ...readings.filter((r) => r.connected).map((r) => r.wabaId),
  ]);
  const wabas: WabaReconciliation[] = [...relevant]
    .sort((a, b) => a.localeCompare(b))
    .map((wabaId) => {
      const last = lastOf.get(wabaId) ?? null;
      const v = byWaba.get(wabaId);
      return {
        wabaId,
        metaReportedCostUsd: v ? round2(v.cost) : null,
        volume: v ? v.volume : null,
        lastFetchedAt: last,
        partial: last === null || Date.parse(last) < end,
      };
    });

  const partial = wabas.length === 0 || wabas.some((w) => w.partial);
  const lastFetchedAt =
    wabas.length === 0 || wabas.some((w) => w.lastFetchedAt === null)
      ? null
      : wabas
          .map((w) => w.lastFetchedAt as string)
          .reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));

  if (inPeriod.length === 0) {
    return {
      metaReportedCostUsd: null,
      differenceUsd: null,
      volume: null,
      wabas,
      lastFetchedAt,
      partial,
    };
  }
  const totalCost = [...byWaba.values()].reduce((s, v) => s + v.cost, 0);
  const volume = [...byWaba.values()].reduce((s, v) => s + v.volume, 0);
  return {
    metaReportedCostUsd: round2(totalCost),
    differenceUsd: round2(statement.metaCostUsd - totalCost),
    volume,
    wabas,
    lastFetchedAt,
    partial,
  };
}

/**
 * Rol de servicio, filtrado por `account_id`. Lanza si la base falla
 * (quien llama decide qué enseñar). Devuelve la conciliación por id de
 * estado de cuenta.
 */
export async function reconcileStatements(
  db: SupabaseClient,
  accountId: string,
  statements: {
    id: string;
    periodStart: string;
    periodEnd: string;
    metaCostUsd: number;
  }[]
): Promise<Map<string, StatementReconciliation>> {
  const out = new Map<string, StatementReconciliation>();
  if (statements.length === 0) return out;

  const from = Math.min(...statements.map((s) => floorDayUtc(s.periodStart)));
  const to = Math.max(...statements.map((s) => floorDayUtc(s.periodEnd)));

  const rows: SnapshotReadRow[] = [];
  for (let page = 0; ; page += 1) {
    // `id` desempata: `period_start` se repite (varias categorías y
    // números por día) y sin un orden total `.range()` puede repetir u
    // omitir filas entre páginas.
    const { data, error } = await db
      .from('meta_spend_snapshots')
      .select('waba_id, period_start, category, volume, cost_usd, fetched_at')
      .eq('account_id', accountId)
      .gte('period_start', new Date(from).toISOString())
      .lt('period_start', new Date(to).toISOString())
      .order('period_start', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as SnapshotReadRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const { data: configs, error: configsErr } = await db
    .from('whatsapp_config')
    .select('waba_id')
    .eq('account_id', accountId)
    .eq('status', 'connected')
    .not('waba_id', 'is', null);
  if (configsErr) throw configsErr;
  const connected = new Set(
    ((configs ?? []) as { waba_id: string | null }[])
      .map((c) => c.waba_id?.trim() ?? '')
      .filter(Boolean)
  );

  const readings: WabaReading[] = [];
  for (const wabaId of new Set([...rows.map((r) => r.waba_id), ...connected])) {
    const last = await lastFetchedAt(db, accountId, wabaId);
    readings.push({
      wabaId,
      lastFetchedAt: last === null ? null : new Date(last).toISOString(),
      connected: connected.has(wabaId),
    });
  }
  for (const s of statements) {
    out.set(s.id, reconcileOne(s, rows, readings));
  }
  return out;
}
