// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Kept out of the route files so `GET/POST /api/v1/contacts` and
// `GET/PATCH /api/v1/contacts/{id}` share one serializer, one
// find-or-create (built on the same `findExistingContact` dedupe the
// webhook and send path use), and one tag-sync routine.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  findContactByWaUserId,
  findExistingContact,
  isUniqueViolation,
} from '@/lib/contacts/dedupe';
import { isValidBsuid } from '@/lib/whatsapp/bsuid';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

/** Row select that embeds the contact's tags for serialization. */
export const CONTACT_SELECT = '*, contact_tags(tags(*))';

export interface ApiContact {
  id: string;
  /** Null cuando el contacto solo se identifica por su BSUID. */
  phone: string | null;
  /** Nombre de usuario de WhatsApp, sin arroba. Null si no tiene. */
  wa_username: string | null;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

type RawTagJoin = { tags: { id: string; name: string; color: string } | null };

/** Flatten a `CONTACT_SELECT` row into the public contact shape. */
export function serializeContact(row: Record<string, unknown>): ApiContact {
  const joins = (row.contact_tags as RawTagJoin[] | undefined) ?? [];
  return {
    id: row.id as string,
    phone: (row.phone as string | null) ?? null,
    wa_username: (row.wa_username as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    company: (row.company as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    tags: joins
      .map((j) => j.tags)
      .filter((t): t is NonNullable<RawTagJoin['tags']> => t != null)
      .map((t) => ({ id: t.id, name: t.name, color: t.color })),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Resolve the audit `user_id` for API-created rows — the SINGLE source
 * of truth used by every public-API write (contacts, messages,
 * broadcasts, resolve-conversation), so the same key's writes are
 * always attributed to the same human. API callers have no logged-in
 * user, so — like the inbound webhook — we attribute writes to the
 * **WhatsApp config owner** (the webhook's own convention). Contacts
 * can be created before WhatsApp is connected, so we fall back to the
 * account owner when there's no config yet.
 */
export async function resolveAuditUserId(
  db: SupabaseClient,
  accountId: string
): Promise<string> {
  // Post-053 an account can have several numbers, so this cannot be a
  // `.maybeSingle()` any more — it would error on the second one. Any
  // of them answers the question equally well (this is an audit column,
  // not a routing decision), so take the oldest for stability: the same
  // account always attributes its API writes to the same human.
  const { data: configs } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1);
  const configOwner = (
    Array.isArray(configs) ? configs[0]?.user_id : undefined
  ) as string | undefined;
  if (configOwner) return configOwner;

  const { data: account } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  const owner = account?.owner_user_id as string | undefined;
  if (!owner) {
    throw new ContactError('Account owner could not be resolved', 500);
  }
  return owner;
}

export interface ContactInput {
  /** E.164. Obligatorio salvo que venga `waUserId` (fase 6 §5). */
  phone?: string;
  /** BSUID, para un contacto del que solo conocemos su nombre de usuario. */
  waUserId?: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

/**
 * Find (by fuzzy phone match, or by BSUID) or create a contact in
 * `accountId`. Returns the contact id and whether it was created.
 * Reuses the shared dedupe helpers + unique-violation race backstop so
 * an API-created contact is indistinguishable from a webhook-created
 * one.
 *
 * Con las dos identidades, el teléfono decide a quién se busca: es lo
 * que la agenda lleva usando desde siempre. El BSUID es la vía para
 * quien escribió con nombre de usuario y nunca nos dio su número.
 */
export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  const sanitized = sanitizePhoneForMeta(input.phone ?? '');
  const waUserId = input.waUserId?.trim() ?? '';

  if (!isValidE164(sanitized)) {
    if (!waUserId) {
      throw new ContactError(
        "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
        400
      );
    }
    if (!isValidBsuid(waUserId)) {
      throw new ContactError(
        "'to_user_id' must be a WhatsApp user id in the form CC.<alphanumerics>",
        400
      );
    }
  }

  const byPhone = isValidE164(sanitized)
    ? await findExistingContact(db, accountId, sanitized)
    : null;
  if (byPhone) return { id: byPhone.id, created: false };

  const byUserId = waUserId
    ? await findContactByWaUserId(db, accountId, waUserId)
    : null;
  if (byUserId) return { id: byUserId.id, created: false };

  const phone = isValidE164(sanitized) ? sanitized : null;
  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      phone,
      wa_user_id: waUserId || null,
      name: input.name ?? phone ?? waUserId,
      email: input.email ?? null,
      company: input.company ?? null,
    })
    .select('id')
    .single();

  if (error || !created) {
    // Lost a race against a concurrent create — one of the unique
    // indexes (022 por teléfono, 060 por BSUID) rejected the duplicate.
    // Re-resolve to the winner.
    if (isUniqueViolation(error)) {
      const racedByPhone = phone
        ? await findExistingContact(db, accountId, phone)
        : null;
      if (racedByPhone) return { id: racedByPhone.id, created: false };
      const racedByUserId = waUserId
        ? await findContactByWaUserId(db, accountId, waUserId)
        : null;
      if (racedByUserId) return { id: racedByUserId.id, created: false };
    }
    console.error('[api/v1/contacts] create error:', error);
    throw new ContactError('Failed to create contact', 500);
  }

  return { id: created.id, created: true };
}

/**
 * Replace a contact's tags to exactly match `tagNames` (case-
 * insensitive; missing tags are created). A no-op when `tagNames` is
 * undefined — pass `[]` to clear all tags. Reuses `resolveImportTagIds`
 * so API and CSV-import tag handling stay consistent.
 */
export async function setContactTags(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  contactId: string,
  tagNames: string[]
): Promise<void> {
  const { tagIdByKey } = await resolveImportTagIds(db, {
    accountId,
    userId: auditUserId,
    tagNames,
    canCreateTags: true,
  });
  const desired = new Set(tagIdByKey.values());

  // Diff against the current joins rather than delete-all-then-insert:
  // a diff only touches tags that actually change, so a mid-operation
  // failure can never wipe tags that were meant to stay. Every write
  // is error-checked and surfaced as a ContactError (→ 500) instead of
  // being swallowed behind a misleading 200.
  const { data: current, error: readErr } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId);
  if (readErr) {
    throw new ContactError('Failed to read contact tags', 500);
  }
  const existing = new Set((current ?? []).map((r) => r.tag_id as string));

  const toAdd = [...desired].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !desired.has(id));

  if (toRemove.length > 0) {
    const { error } = await db
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .in('tag_id', toRemove);
    if (error) throw new ContactError('Failed to update contact tags', 500);
  }
  if (toAdd.length > 0) {
    for (const tagId of toAdd) {
      try {
        await addContactTagAndDispatch({
          db,
          accountId,
          contactId,
          tagId,
        });
      } catch (error) {
        console.error('[api/v1/contacts] tag add failed:', error);
        throw new ContactError('Failed to update contact tags', 500);
      }
    }
  }
}

/** Fetch + serialize a single contact scoped to the account, or null. */
export async function getContactById(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<ApiContact | null> {
  const { data, error } = await db
    .from('contacts')
    .select(CONTACT_SELECT)
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  return serializeContact(data as Record<string, unknown>);
}
