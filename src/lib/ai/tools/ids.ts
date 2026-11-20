// ============================================================
// Guardia de ids de la IA (p16.4 D1, audit-ai.md hallazgo 1).
//
// Un id protegido (un parámetro `in: 'path'`, o `patient_id` en query o
// body) solo se manda a la integración si su valor salió de un resultado
// `ok` de una herramienta de ESTA conversación: así un cliente no puede
// teclear «cancela la cita 1235» y actuar sobre la de otro paciente.
//
// Evidencia = valores de las claves `id` / `*_id` de los resultados `ok`,
// por integración. Los del turno viven en el bucle; los de turnos
// anteriores, en una caché de proceso por (cuenta, conversación).
// ============================================================

import type { OperationParam } from '@/lib/integrations/types';

import { AI_EVIDENCE_WINDOW_MS } from './types';

/** Conversaciones como mucho en la caché de proceso. */
export const AI_ID_CACHE_MAX = 500;
/** Ids como mucho por conversación (los más viejos salen primero). */
export const AI_ID_CACHE_IDS_MAX = 1000;
const COLLECT_MAX_DEPTH = 8;
const COLLECT_MAX_ITEMS = 2000;

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

/** Clave de evidencia: el id solo vale en la integración que lo devolvió. */
export function idKey(slug: string, value: string): string {
  return `${slug}\u0000${value}`;
}

/** Valores de ids protegidos de los argumentos (ya aplanados). */
export function protectedIdValues(
  declared: OperationParam[],
  flatArgs: Record<string, unknown>
): string[] {
  const out: string[] = [];
  for (const p of declared) {
    if (!isProtectedParam(p) || !Object.hasOwn(flatArgs, p.name)) continue;
    const text = idText(flatArgs[p.name]);
    if (text !== null) out.push(text);
  }
  return out;
}

/** Valores de `id` / `*_id` de un resultado (anidados, con topes). */
export function collectResultIds(data: unknown): string[] {
  const out: string[] = [];
  let visited = 0;
  const walk = (node: unknown, depth: number) => {
    if (depth > COLLECT_MAX_DEPTH || visited >= COLLECT_MAX_ITEMS) return;
    visited += 1;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'id' || key.endsWith('_id')) {
        const text = idText(value);
        if (text !== null) out.push(text);
      }
      if (typeof value === 'object' && value !== null) walk(value, depth + 1);
    }
  };
  walk(data, 0);
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
