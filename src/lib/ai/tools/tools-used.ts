// ============================================================
// `toolsUsed` tal como llega de /api/ai/playground y /api/ai/draft
// (n13.3, R35, R36). Puro: lo usan el playground y el compositor.
// ============================================================

import type { ToolUseRecord } from './types';

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
