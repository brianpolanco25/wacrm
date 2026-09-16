// ============================================================
// Shared tag logic for the public API (v1) tag endpoints (fase 7 §2).
//
// Kept out of the route files so `GET/POST /api/v1/tags`,
// `GET/PATCH/DELETE /api/v1/tags/{id}` and the two contact-assignment
// routes share one serializer, one name normaliser and one
// find-or-create.
//
// Two rules this module exists to keep in one place:
//
//   1. **Names are matched case-insensitively, exactly.** `resolve-
//      import-tags.ts` (CSV import) and `setContactTags` (tags by name
//      on a contact) already key tags by `name.trim().toLowerCase()`.
//      If the API matched differently, `POST /api/v1/tags {"name":
//      "VIP"}` and `PATCH /api/v1/contacts/{id} {"tags":["vip"]}` would
//      end up pointing at two different rows. The comparison is done in
//      Node rather than with PostgREST's `ilike` on purpose: `ilike`
//      takes a PATTERN, so a tag legitimately called `50%` or `a_b`
//      would match rows it has nothing to do with, and PostgREST has no
//      `ESCAPE` clause to fix that.
//   2. **Every query carries `.eq('account_id', …)`.** These run on the
//      service-role client, which bypasses RLS (CP3).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** Columns the public shape needs. `user_id` is audit data, not public. */
export const TAG_COLUMNS = 'id, name, color, created_at';

/** Same default the dashboard's tag manager and the CSV import use. */
export const DEFAULT_TAG_COLOR = '#3b82f6';

/**
 * Upper bound on a tag name. The 1 MiB body ceiling already stops the
 * absurd case; this stops the merely unusable one (a tag is rendered as
 * a pill next to a contact). Not in the spec — see the implementation
 * report.
 */
export const MAX_TAG_NAME_LENGTH = 64;

export interface ApiTag {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class TagError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'TagError';
    this.status = status;
  }
}

export function serializeTag(row: Record<string, unknown>): ApiTag {
  return {
    id: row.id as string,
    name: row.name as string,
    color: (row.color as string | null) ?? DEFAULT_TAG_COLOR,
    created_at: row.created_at as string,
  };
}

/** The key a tag is matched by: trimmed and lower-cased. */
export function tagKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Validate a caller-supplied tag name. Returns the trimmed name, or
 * null when it is absent, not a string, empty or too long — the route
 * turns that into a `bad_request` naming the field.
 */
export function normalizeTagName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > MAX_TAG_NAME_LENGTH) return null;
  return name;
}

/**
 * Validate a caller-supplied colour: `#rgb` or `#rrggbb`, returned as
 * lower-case `#rrggbb`. Anything else is null (→ `bad_request`); the
 * value is interpolated into inline styles all over the dashboard, so
 * it is never stored as free text.
 */
export function normalizeTagColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return null;
}

/**
 * How many rows {@link findTagByName} is willing to scan.
 *
 * The comparison happens in Node (see the header), so the query reads
 * the account's roster. Explicit rather than implicit on purpose: with
 * no `.limit()` PostgREST applies its own `db-max-rows` (1000 by
 * default) and the read would silently stop returning existing tags
 * past that line — the find half of find-or-create would start missing
 * and the account would collect near-duplicates. With the limit
 * written here the ceiling is visible, and since migration 064 the
 * unique index catches whatever slips past it anyway (the insert comes
 * back 23505 and is treated as "it already existed").
 *
 * A tag roster is settings-class data — a handful of rows per account —
 * so this is a guard rail, not a paging strategy.
 */
export const TAG_ROSTER_SCAN_LIMIT = 1000;

/**
 * The account's tag whose name matches `name` case-insensitively, or
 * null. Reads the account's tags and compares in Node (see the header):
 * the roster is settings-class, a handful of rows per account.
 */
export async function findTagByName(
  db: SupabaseClient,
  accountId: string,
  name: string
): Promise<ApiTag | null> {
  const { data, error } = await db
    .from('tags')
    .select(TAG_COLUMNS)
    .eq('account_id', accountId)
    .limit(TAG_ROSTER_SCAN_LIMIT);
  if (error) throw new TagError('Failed to read tags', 500);

  const key = tagKey(name);
  const match = (data ?? []).find(
    (row) => tagKey(String((row as Record<string, unknown>).name ?? '')) === key
  );
  return match ? serializeTag(match as Record<string, unknown>) : null;
}

/** Fetch + serialize one tag scoped to the account, or null. */
export async function getTagById(
  db: SupabaseClient,
  accountId: string,
  tagId: string
): Promise<ApiTag | null> {
  const { data, error } = await db
    .from('tags')
    .select(TAG_COLUMNS)
    .eq('id', tagId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  return serializeTag(data as Record<string, unknown>);
}

/**
 * Find-or-create by name (case-insensitive). `created` is false when an
 * existing tag answered — the route turns that into `200` instead of
 * `201`, and the existing tag's colour is left alone: a caller that
 * re-posts a name it already has is naming a tag, not repainting it.
 *
 * Read-then-insert on its own is not safe under concurrency: two calls
 * with the same name can both read "no such tag" and both insert. What
 * closes that window is the unique index on `(account_id, lower(name))`
 * (migration 064) — the loser of the race gets `23505`, and **that is
 * not an error here**: somebody else just created exactly the tag this
 * caller asked for, which is the answer find-or-create promises. So the
 * row is read back and returned with `created: false`, the same `200`
 * the caller would have got a millisecond later. The dashboard's tag
 * manager inserts straight into Supabase, so the race is real between
 * the API and the panel, not just between two API calls.
 */
export async function findOrCreateTag(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  name: string,
  color: string = DEFAULT_TAG_COLOR
): Promise<{ tag: ApiTag; created: boolean }> {
  const existing = await findTagByName(db, accountId, name);
  if (existing) return { tag: existing, created: false };

  const { data, error } = await db
    .from('tags')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      name: name.trim(),
      color,
    })
    .select(TAG_COLUMNS)
    .single();

  if (error?.code === '23505') {
    // Lost the race (or the roster is longer than the scan limit).
    // Re-read: the winner's row is the answer.
    const winner = await findTagByName(db, accountId, name);
    if (winner) return { tag: winner, created: false };
    // Only reachable if the re-read cannot see the row that just
    // collided — a roster past TAG_ROSTER_SCAN_LIMIT. Never retry the
    // insert: it would collide again. Say so instead of looping.
    throw new TagError('Tag name already in use', 409);
  }

  if (error || !data) {
    console.error('[api/v1/tags] create error:', error);
    throw new TagError('Failed to create tag', 500);
  }
  return { tag: serializeTag(data as Record<string, unknown>), created: true };
}
