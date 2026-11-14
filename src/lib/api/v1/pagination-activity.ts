// ============================================================
// Cursor por última actividad (`GET /conversations?sort=last_activity`).
//
// Mismo contrato que `pagination.ts` (cursor opaco base64url, keyset), pero
// con orden `(last_message_at desc nulls last, id desc)`. Las
// conversaciones sin mensajes (`last_message_at` nulo) van al final, así
// que el cursor puede estar ya en esa zona: entonces lleva el timestamp
// vacío y solo avanza por `id`. Misma validación estricta que
// `decodeCursor`, porque los valores se interpolan en un `.or()`.
// ============================================================

import { parseListParams } from '@/lib/api/v1/pagination';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActivityCursor {
  /** `null` = ya en la zona de conversaciones sin mensajes. */
  lastMessageAt: string | null;
  id: string;
}

export function encodeActivityCursor(row: {
  last_message_at: string | null;
  id: string;
}): string {
  return Buffer.from(`${row.last_message_at ?? ''}|${row.id}`, 'utf8').toString(
    'base64url'
  );
}

/** Decode a cursor, or null if missing/malformed/untrusted (→ first page). */
export function decodeActivityCursor(
  value: string | null
): ActivityCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep === -1) return null;
    const ts = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!UUID_RE.test(id)) return null;
    if (ts === '') return { lastMessageAt: null, id };
    if (Number.isNaN(Date.parse(ts))) return null;
    return { lastMessageAt: ts, id };
  } catch {
    return null;
  }
}

/** Parse `?limit` and `?cursor` (activity flavour). */
export function parseActivityListParams(request: Request): {
  limit: number;
  cursor: ActivityCursor | null;
} {
  const { limit } = parseListParams(request);
  const url = new URL(request.url);
  return {
    limit,
    cursor: decodeActivityCursor(url.searchParams.get('cursor')),
  };
}

/** `.or()` expression that walks past an activity cursor. Null on page one. */
export function activityKeysetFilter(
  cursor: ActivityCursor | null
): string | null {
  if (!cursor) return null;
  if (cursor.lastMessageAt === null) {
    return `and(last_message_at.is.null,id.lt.${cursor.id})`;
  }
  return `last_message_at.lt.${cursor.lastMessageAt},and(last_message_at.eq.${cursor.lastMessageAt},id.lt.${cursor.id}),last_message_at.is.null`;
}

export function buildActivityPage<
  T extends { last_message_at: string | null; id: string },
>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeActivityCursor(items[items.length - 1]) };
}
