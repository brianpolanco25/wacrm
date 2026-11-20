// ============================================================
// Guardia de ids de la IA (p16.4 D1, audit-ai.md hallazgo 1).
//
// Un id protegido (un parámetro `in: 'path'`, o `patient_id` en query o
// body) solo se manda a la integración si su valor salió de un resultado
// `ok` de una herramienta de ESTA conversación: así un cliente no puede
// teclear «cancela la cita 1235» y actuar sobre la de otro paciente.
//
// La evidencia está tipada por origen: (integración, operación, campo,
// valor). Campo = `id` (id de registro) o una clave `*_id` de nivel
// superior del registro. Registros = `data` (si es objeto), `data[]` y
// `data.<lista>[]`; nada anidado en sub-objetos (`practitioner`,
// `location`, `center`) cuenta. Sin `data` en el cuerpo, la raíz hace de
// `data`.
//
// Qué orígenes acepta cada parámetro lo declara `ai_policy.ids` de la
// operación (`op` = id de registro de `op`; `op.campo` = esa clave). Sin
// declaración, vale solo un id de registro de cualquier operación de la
// integración: valor por defecto que NO distingue entidades (dos tablas
// con enteros pequeños colisionan); toda operación con ids protegidos de
// una integración real debería declararlo.
// ============================================================

import type { OperationParam } from '@/lib/integrations/types';

import { AI_EVIDENCE_WINDOW_MS } from './types';

/** Conversaciones como mucho en la caché de proceso. */
export const AI_ID_CACHE_MAX = 500;
/** Ids como mucho por conversación (los más viejos salen primero). */
export const AI_ID_CACHE_IDS_MAX = 1000;
const RECORDS_MAX = 500;

/** ¿Es un id protegido? Declarativo: ruta, o `patient_id` en query/body. */
export function isProtectedParam(p: OperationParam): boolean {
  if (p.in === 'path') return true;
  return (
    (p.in === 'query' || p.in === 'body') &&
    p.name.split('.').pop() === 'patient_id'
  );
}

function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Origen comodín de un id de registro (lo que acepta el valor por defecto). */
const ANY_OP = '*';

/** Clave de evidencia: integración, operación de origen, campo y valor. */
export function idKey(
  slug: string,
  op: string,
  field: string,
  value: string
): string {
  return `${slug}\u0000${op}\u0000${field}\u0000${value}`;
}

/** Ids protegidos de los argumentos (ya aplanados): parámetro y valor. */
export function protectedIdValues(
  declared: OperationParam[],
  flatArgs: Record<string, unknown>
): { param: string; value: string }[] {
  const out: { param: string; value: string }[] = [];
  for (const p of declared) {
    if (!isProtectedParam(p) || !Object.hasOwn(flatArgs, p.name)) continue;
    const value = idText(flatArgs[p.name]);
    if (value !== null) out.push({ param: p.name, value });
  }
  return out;
}

/**
 * ¿Hay evidencia para este valor? `sources` = `ai_policy.ids[param]` de la
 * operación; sin ella, un id de registro de cualquier operación.
 */
export function isKnownId(
  known: Set<string>,
  slug: string,
  value: string,
  sources: string[] | undefined
): boolean {
  if (!sources) return known.has(idKey(slug, ANY_OP, 'id', value));
  return sources.some((source) => {
    const [op, field = 'id'] = source.split('.');
    return known.has(idKey(slug, op, field, value));
  });
}

/** Claves de evidencia de un resultado `ok` de `op`. */
export function collectResultIds(
  slug: string,
  op: string,
  body: unknown
): string[] {
  const root =
    isPlainObject(body) && Object.hasOwn(body, 'data') ? body.data : body;
  const records: unknown[] = [];
  if (Array.isArray(root)) records.push(...root);
  else if (isPlainObject(root)) {
    records.push(root);
    for (const value of Object.values(root)) {
      if (Array.isArray(value)) records.push(...value);
    }
  }
  const out: string[] = [];
  for (const record of records.slice(0, RECORDS_MAX)) {
    if (!isPlainObject(record)) continue;
    for (const [field, raw] of Object.entries(record)) {
      if (field !== 'id' && !field.endsWith('_id')) continue;
      const value = idText(raw);
      if (value === null) continue;
      out.push(idKey(slug, op, field, value));
      if (field === 'id') out.push(idKey(slug, ANY_OP, 'id', value));
    }
  }
  return out;
}

// shortcut: in-process, se pierde al reiniciar o desplegar y con más de una
// instancia; entonces el modelo vuelve a buscar. Pasar a una columna en
// integration_calls si eso molesta.
interface CacheEntry {
  expiresAt: number;
  ids: Set<string>;
}
const cache = new Map<string, CacheEntry>();

function convKey(accountId: string, conversationId: string): string {
  return `${accountId}\u0000${conversationId}`;
}

/** Ids (claves `idKey`) vistos en turnos anteriores de la conversación. */
export function knownConversationIds(
  accountId: string,
  conversationId: string,
  now: number
): Set<string> {
  const key = convKey(accountId, conversationId);
  const entry = cache.get(key);
  if (!entry) return new Set();
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return new Set();
  }
  return new Set(entry.ids);
}

/** Guarda ids (claves `idKey`) de la conversación; renueva las 24 h. */
export function rememberConversationIds(
  accountId: string,
  conversationId: string,
  keys: string[],
  now: number
): void {
  if (keys.length === 0) return;
  const key = convKey(accountId, conversationId);
  const prev = cache.get(key);
  const ids = prev && prev.expiresAt > now ? prev.ids : new Set<string>();
  for (const k of keys) {
    ids.delete(k);
    ids.add(k);
  }
  while (ids.size > AI_ID_CACHE_IDS_MAX) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, { expiresAt: now + AI_EVIDENCE_WINDOW_MS, ids });
  while (cache.size > AI_ID_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Solo tests: simula un reinicio del proceso. */
export function __resetIdCacheForTests(): void {
  cache.clear();
}
