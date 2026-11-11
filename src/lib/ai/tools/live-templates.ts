// ============================================================
// Plantillas de fecha y validación de lecturas en vivo (n13.7, R2–R5).
//
// Puro. Una lectura en vivo es una operación `GET` de la integración con
// parámetros fijos que el admin escribe en Ajustes; sus cadenas admiten
// `{{today}}` y `{{today+Nd}}` (N de 1 a 60), que se resuelven a la
// fecha local `YYYY-MM-DD` de la zona de la integración (UTC sin zona).
// ============================================================

import { callerParams, validateCallParams } from '@/lib/integrations/request';
import type { HttpMethod, OperationParam } from '@/lib/integrations/types';

import { isValidTimeZone } from './prompt';
import { AI_LIVE_READS_MAX, type AiLiveRead } from './types';

/** R3: `{{today}}` o `{{today+Nd}}`; N se comprueba aparte (1..60). */
export const LIVE_TEMPLATE_RE = /\{\{\s*today(?:\+(\d{1,2})d)?\s*\}\}/g;
const LIVE_TEMPLATE_MAX_DAYS = 60;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * R4: la fecha local de `now` en `timeZone` (UTC si es `null` o no vale)
 * más `plusDays` días de CALENDARIO: se suma sobre la fecha, no sobre
 * milisegundos, para no fallar en un cambio de hora.
 */
export function localDateInZone(
  now: Date,
  timeZone: string | null,
  plusDays = 0
): string {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const date = new Date(
    Date.UTC(get('year'), get('month') - 1, get('day') + plusDays)
  );
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** R4: sustituye las plantillas conocidas; el resto del texto queda igual. */
export function resolveLiveTemplates(
  value: string,
  now: Date,
  timeZone: string | null
): string {
  return value.replace(LIVE_TEMPLATE_RE, (_m, days: string | undefined) =>
    localDateInZone(now, timeZone, days === undefined ? 0 : Number(days))
  );
}

/** R3: `true` si hay un `{{` que no es una plantilla válida. */
export function hasUnknownTemplate(value: string): boolean {
  if (!value.includes('{{') && !value.includes('}}')) return false;
  let invalid = false;
  const rest = value.replace(
    LIVE_TEMPLATE_RE,
    (_m, days: string | undefined) => {
      if (days !== undefined) {
        const n = Number(days);
        if (!Number.isInteger(n) || n < 1 || n > LIVE_TEMPLATE_MAX_DAYS) {
          invalid = true;
        }
      }
      return '';
    }
  );
  return invalid || rest.includes('{{') || rest.includes('}}');
}

/** Resuelve las plantillas de todos los parámetros de texto. */
export function resolveLiveParams(
  params: Record<string, string | number | boolean>,
  now: Date,
  timeZone: string | null
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(params)) {
    out[name] =
      typeof value === 'string'
        ? resolveLiveTemplates(value, now, timeZone)
        : value;
  }
  return out;
}

export interface LiveReadOperation {
  key: string;
  method: HttpMethod;
  is_active: boolean;
  params: OperationParam[] | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * R2/R3/R5: la lista que guarda el PATCH, o el primer problema. Las
 * plantillas se resuelven a `opts.now` para validar tipos y requeridos
 * con `validateCallParams`, pero se guardan sin resolver.
 */
export function validateLiveReads(
  raw: unknown,
  operations: LiveReadOperation[],
  opts: { now: Date; timeZone: string | null }
): { ok: true; value: AiLiveRead[] } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'aiLiveReads must be a list' };
  }
  if (raw.length > AI_LIVE_READS_MAX) {
    return {
      ok: false,
      error: `aiLiveReads accepts at most ${AI_LIVE_READS_MAX} entries`,
    };
  }
  const byKey = new Map(operations.map((op) => [op.key, op]));
  const value: AiLiveRead[] = [];
  for (const [index, entry] of raw.entries()) {
    const at = `aiLiveReads[${index}]`;
    if (!isPlainObject(entry) || typeof entry.operation !== 'string') {
      return { ok: false, error: `${at} needs an operation` };
    }
    const op = byKey.get(entry.operation);
    if (!op || !op.is_active || op.method !== 'GET') {
      return {
        ok: false,
        error: `${at}: the operation must be an active read (GET) operation of this integration`,
      };
    }
    const rawParams = entry.params ?? {};
    if (!isPlainObject(rawParams)) {
      return { ok: false, error: `${at}: params must be an object` };
    }
    const declared = callerParams(op.params ?? []);
    const names = new Set(declared.map((p) => p.name));
    const params: Record<string, string | number | boolean> = {};
    for (const [name, v] of Object.entries(rawParams)) {
      if (!names.has(name)) {
        return { ok: false, error: `${at}: unknown parameter ${name}` };
      }
      if (
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
      ) {
        return {
          ok: false,
          error: `${at}: parameter ${name} must be a text, number or boolean`,
        };
      }
      if (typeof v === 'string' && hasUnknownTemplate(v)) {
        return {
          ok: false,
          error: `${at}: parameter ${name} uses an unknown template (only {{today}} and {{today+Nd}}, N from 1 to 60)`,
        };
      }
      // Un texto vacío es «sin valor»: no se guarda.
      if (typeof v === 'string' && v.trim() === '') continue;
      params[name] = v;
    }
    const check = validateCallParams(
      declared,
      resolveLiveParams(params, opts.now, opts.timeZone)
    );
    if (!check.ok) {
      return {
        ok: false,
        error: `${at}: parameter ${check.param} is ${check.problem}`,
      };
    }
    value.push({ operation: op.key, params });
  }
  return { ok: true, value };
}

/** R15: lo que se lee de la base, sin lanzar: entradas mal formadas fuera. */
export function readStoredLiveReads(raw: unknown): AiLiveRead[] {
  if (!Array.isArray(raw)) return [];
  const out: AiLiveRead[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.operation !== 'string') continue;
    const params: Record<string, string | number | boolean> = {};
    if (isPlainObject(entry.params)) {
      for (const [name, v] of Object.entries(entry.params)) {
        if (
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean'
        ) {
          params[name] = v;
        }
      }
    }
    out.push({ operation: entry.operation, params });
    if (out.length >= AI_LIVE_READS_MAX) break;
  }
  return out;
}
