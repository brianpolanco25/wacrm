// ============================================================
// `toolsUsed` tal como llega de /api/ai/playground y /api/ai/draft
// (n13.3, R35, R36). Puro: lo usan el playground y el compositor.
// ============================================================

import { AI_TRAIL_MAX, type PriorEvidence, type ToolUseRecord } from './types';

function isToolUseRecord(u: unknown): u is ToolUseRecord {
  return (
    typeof u === 'object' &&
    u !== null &&
    typeof (u as { integration?: unknown }).integration === 'string' &&
    typeof (u as { operation?: unknown }).operation === 'string' &&
    typeof (u as { ok?: unknown }).ok === 'boolean'
  );
}

/** Las entradas bien formadas; `undefined` si no es una lista. */
export function readToolsUsed(raw: unknown): ToolUseRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(isToolUseRecord);
}

/** R36: `"Health · search, Health · list"`; `''` si no hay nada válido. */
export function formatToolsUsed(raw: unknown): string {
  return (readToolsUsed(raw) ?? [])
    .map((u) => `${u.integration} · ${u.operation}`)
    .join(', ');
}

/** n13.7 R32: una entrada del `trail` que manda el playground. */
export interface TrailEntry {
  slug: string;
  operation: string;
  ok: true;
}

function isTrailEntry(u: unknown): u is TrailEntry {
  if (typeof u !== 'object' || u === null || Array.isArray(u)) return false;
  const e = u as Record<string, unknown>;
  return (
    typeof e.slug === 'string' &&
    e.slug.length > 0 &&
    e.slug.length <= 64 &&
    typeof e.operation === 'string' &&
    e.operation.length > 0 &&
    e.operation.length <= 64 &&
    e.ok === true &&
    e.blocked === undefined
  );
}

/**
 * n13.7 R32: el `trail` del cuerpo del playground → evidencia previa. Las
 * entradas mal formadas, fallidas o bloqueadas se descartan; de las
 * válidas se quedan las 50 más recientes, en orden.
 */
export function readTrail(raw: unknown): PriorEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isTrailEntry)
    .slice(-AI_TRAIL_MAX)
    .map((e) => ({ integrationSlug: e.slug, operationKey: e.operation }));
}

/**
 * n13.7 R32: lo que el playground acumula de una respuesta para el
 * siguiente turno (solo las `ok`, no bloqueadas y con slug).
 */
export function trailFromToolsUsed(raw: unknown): TrailEntry[] {
  return (readToolsUsed(raw) ?? [])
    .filter((u) => u.ok && !u.blocked && typeof u.slug === 'string')
    .map((u) => ({ slug: u.slug as string, operation: u.operation, ok: true }));
}
