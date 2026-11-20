import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { sanitizeBsuid } from '@/lib/whatsapp/bsuid';

/**
 * Contact de-duplication helpers, shared by the WhatsApp webhook, the
 * manual contact form, and CSV import so all paths agree on what
 * "same number" means (issue #212).
 *
 * The canonical key is `normalizePhone` (digits-only) — the same form
 * the DB stores in the generated `contacts.phone_normalized` column
 * and enforces unique per account. `findExistingContact` also accepts
 * trunk-0 variants and national numbers saved without country code.
 */

/** Canonical de-dup key for a phone string (digits only). */
export function normalizeKey(phone: string): string {
  return normalizePhone(phone);
}

/**
 * The other form Meta and agents use for the same mobile in Mexico
 * (`52` + 10 ↔ `521` + 10) and Argentina (`54` + 10 ↔ `549` + 10), or ''.
 */
function mobilePrefixTwin(d: string): string {
  let m = d.match(/^52(1?)(\d{10})$/);
  if (m) return (m[1] ? '52' : '521') + m[2];
  m = d.match(/^54(9?)(\d{10})$/);
  if (m) return (m[1] ? '54' : '549') + m[2];
  return '';
}

/** Minimal shape we need back from a contacts lookup. */
export interface ExistingContact {
  id: string;
  /** Nullable desde la migración 060: un contacto puede existir solo
   *  con su BSUID, porque Meta ya no siempre manda el teléfono. */
  phone: string | null;
  name?: string | null;
  wa_user_id?: string | null;
  wa_username?: string | null;
  [key: string]: unknown;
}

/**
 * Find an existing contact in `accountId` whose phone matches `phone`,
 * or null. Pre-filters in SQL by the last 7 digits of the digits-only
 * `phone_normalized` (the raw `phone` keeps the user's formatting, so
 * `…555-1234` never matched `%95551234`; 7 so a 7-digit saved number
 * still enters). Then, in order: exact digits; a trunk-0 variant
 * (`370063949836` ↔ `37063949836`); one number a suffix of the other
 * with the shorter ≥ 7 digits (`8095551234` saved without country code
 * ↔ `18095551234`), longest suffix first. A bare shared tail is NOT
 * enough: 1-809-555-1234 and 1-829-555-1234 are different people.
 * The suffix rule only covers a missing country code (1–3 digits).
 */
export async function findExistingContact(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const suffix = normalized.slice(-7);

  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .like('phone_normalized', `%${suffix}`);

  if (error || !data) return null;

  const rows = data as ExistingContact[];
  const digits = (c: ExistingContact) => normalizePhone(c.phone ?? '');
  const variants = [
    ...phoneVariants(normalized),
    mobilePrefixTwin(normalized),
  ].filter(Boolean);
  // Length of the shorter number when the longer one is it plus a
  // missing country code (1–3 digits), else 0.
  const suffixLen = (c: ExistingContact) => {
    const d = digits(c);
    const [short, long] =
      d.length <= normalized.length ? [d, normalized] : [normalized, d];
    const missing = long.length - short.length;
    return short.length >= 7 &&
      missing >= 1 &&
      missing <= 3 &&
      long.endsWith(short)
      ? short.length
      : 0;
  };
  const bySuffix = rows
    .filter((c) => suffixLen(c) > 0)
    .sort((a, b) => suffixLen(b) - suffixLen(a));
  // Two candidates equally good by suffix: ambiguous, match neither.
  const suffixHit =
    bySuffix.length > 1 && suffixLen(bySuffix[0]) === suffixLen(bySuffix[1])
      ? null
      : bySuffix[0];
  return (
    rows.find((c) => digits(c) === normalized) ??
    rows.find((c) => variants.includes(digits(c))) ??
    suffixHit ??
    null
  );
}

/**
 * Find the contact of `accountId` that owns `waUserId` (the BSUID), or
 * null.
 *
 * Exact match, no fuzziness: the BSUID is an opaque identifier issued
 * by Meta, unique per (business portfolio, user) — which in this schema
 * is per account — and backed by the partial unique index of migration
 * 060. It is the FIRST thing the inbound webhook tries, because since
 * April 2026 it is the only identity Meta always sends.
 *
 * Account-scoped on purpose: the same person writing to two different
 * customers of this CRM gets a different BSUID for each, but nothing
 * stops Meta from reusing a value across portfolios, and the service
 * role client used by the webhook has no RLS to fall back on (CP3).
 */
export async function findContactByWaUserId(
  db: SupabaseClient,
  accountId: string,
  waUserId: string
): Promise<ExistingContact | null> {
  const id = sanitizeBsuid(waUserId);
  if (!id) return null;

  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_user_id', id)
    .maybeSingle();

  if (error || !data) return null;
  return data as ExistingContact;
}

/**
 * True when an existing contact is an *exact* normalized match for
 * `phone` (vs only a fuzzy trunk-variant match). The form hard-blocks
 * exact matches but only warns on fuzzy ones.
 */
export function isExactMatch(
  existing: ExistingContact,
  phone: string
): boolean {
  if (!existing.phone) return false;
  return normalizeKey(existing.phone) === normalizeKey(phone);
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505).
 * Used as the backstop when the DB unique index rejects a racing or
 * format-equal insert that slipped past the in-app check.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === '23505';
}

/**
 * De-duplicate parsed CSV rows by normalized phone, keeping the first
 * occurrence of each. Rows with an empty normalized phone are dropped
 * (they can't be a valid contact). Returns the unique rows plus the
 * count removed as in-file duplicates.
 */
export function dedupeByPhone<T extends { phone: string }>(
  rows: T[]
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;

  for (const row of rows) {
    const key = normalizeKey(row.phone);
    if (!key) {
      duplicates++;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicates };
}
