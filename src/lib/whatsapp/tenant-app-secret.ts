import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from './encryption';
import { signatureMatchesAnyVariant } from './webhook-signature';

/**
 * Webhooks signed by a TENANT's own Meta app.
 *
 * The platform verifies deliveries with its own `META_APP_SECRET`. A
 * business that connects a number through its own Meta app (its own
 * WABA, its own system-user token — the shape the WhatsApp Business app
 * coexistence onboarding needs, which the platform's app cannot offer
 * until Meta approves it for third-party businesses) points that app's
 * webhook at the same URL, and Meta signs those deliveries with THAT
 * app's secret. Without this module every one of them was a 401.
 *
 * How it stays safe without trusting the body before verifying it:
 *   1. The body is parsed only to learn WHICH phone numbers it claims
 *      to be about (`metadata.phone_number_id` of each change).
 *   2. Only the rows for those numbers are loaded, and only their own
 *      stored secrets are tried. A secret therefore can never vouch for
 *      a number it does not belong to: a tenant holding one app secret
 *      cannot forge events for another tenant's number.
 *   3. Every claimed number must have a secret and every one of those
 *      secrets must match the HMAC — one miss rejects the delivery. In
 *      practice Meta sends one app's numbers per delivery, so this is
 *      one row and one comparison.
 */

const MAX_NUMBERS_PER_DELIVERY = 50;

interface WebhookBodyShape {
  entry?: {
    changes?: { value?: { metadata?: { phone_number_id?: unknown } } }[];
  }[];
}

/** The distinct `phone_number_id`s a delivery claims to be about, in
 *  order of first appearance. Empty when the body is not Meta-shaped. */
export function extractPhoneNumberIds(rawBody: string): string[] {
  let body: WebhookBodyShape;
  try {
    body = JSON.parse(rawBody) as WebhookBodyShape;
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const id = change?.value?.metadata?.phone_number_id;
      if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
      if (ids.length >= MAX_NUMBERS_PER_DELIVERY) return ids;
    }
  }
  return ids;
}

/**
 * The WhatsApp account ids (`entry.id`) of the changes that carry NO
 * `metadata.phone_number_id`. Account-level events (`account_update`:
 * coexistence, partner and number changes) name the account, never a
 * number, so the per-number lookup above cannot place them.
 */
export function extractAccountOnlyWabaIds(rawBody: string): string[] {
  let body: {
    entry?: { id?: unknown; changes?: { value?: { metadata?: unknown } }[] }[];
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of body?.entry ?? []) {
    if (typeof entry?.id !== 'string' || !entry.id || ids.includes(entry.id)) {
      continue;
    }
    const changes = entry.changes ?? [];
    const names = (c: { value?: { metadata?: unknown } }) =>
      (c?.value?.metadata as { phone_number_id?: unknown } | undefined)
        ?.phone_number_id;
    if (
      changes.length > 0 &&
      changes.every((c) => typeof names(c) !== 'string')
    ) {
      ids.push(entry.id);
    }
    if (ids.length >= MAX_NUMBERS_PER_DELIVERY) break;
  }
  return ids;
}

/**
 * Pure decision: given the secrets stored for the numbers the delivery
 * claims (null = that number has no tenant app secret), is the
 * signature valid for all of them?
 */
export function tenantSignatureDecision(
  rawBody: string,
  signatureHeader: string | null,
  secretsByNumber: ReadonlyMap<string, string | null>,
  claimedNumbers: readonly string[]
): boolean {
  if (claimedNumbers.length === 0) return false;
  for (const id of claimedNumbers) {
    const secret = secretsByNumber.get(id);
    if (!secret) return false;
    if (!signatureMatchesAnyVariant(rawBody, signatureHeader, secret)) {
      return false;
    }
  }
  return true;
}

/**
 * The stored app secret (decrypted) of each number a delivery names;
 * null = the number has no row, no secret, or the secret cannot be
 * decrypted. Any failure to read or decrypt counts as "no secret".
 */
export async function loadTenantSecrets(
  db: SupabaseClient,
  claimed: readonly string[]
): Promise<ReadonlyMap<string, string | null> | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('phone_number_id, app_secret')
    .in('phone_number_id', claimed);
  if (error) {
    console.error('[webhook] tenant app secret lookup failed:', error.message);
    return null;
  }

  const secrets = new Map<string, string | null>();
  for (const row of (data ?? []) as {
    phone_number_id: string;
    app_secret: string | null;
  }[]) {
    let plain: string | null = null;
    if (row.app_secret) {
      try {
        plain = decrypt(row.app_secret) || null;
      } catch (err) {
        console.error(
          `[webhook] tenant app secret for ${row.phone_number_id} cannot be decrypted:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    secrets.set(row.phone_number_id, plain);
  }
  return secrets;
}

/**
 * Pure decision for account-level events: every account the delivery
 * names must have at least one stored secret that signs it. Rows of one
 * account belong to one Meta app, so any of its secrets vouches for it.
 */
export function wabaSignatureDecision(
  rawBody: string,
  signatureHeader: string | null,
  secretsByWaba: ReadonlyMap<string, readonly string[]>,
  claimedWabas: readonly string[]
): boolean {
  if (claimedWabas.length === 0) return false;
  return claimedWabas.every((waba) =>
    (secretsByWaba.get(waba) ?? []).some((secret) =>
      signatureMatchesAnyVariant(rawBody, signatureHeader, secret)
    )
  );
}

async function loadWabaSecrets(
  db: SupabaseClient,
  wabaIds: readonly string[]
): Promise<ReadonlyMap<string, readonly string[]> | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('waba_id, app_secret')
    .in('waba_id', wabaIds);
  if (error) {
    console.error('[webhook] account app secret lookup failed:', error.message);
    return null;
  }
  const map = new Map<string, string[]>();
  for (const row of (data ?? []) as {
    waba_id: string;
    app_secret: string | null;
  }[]) {
    if (!row.app_secret) continue;
    try {
      const plain = decrypt(row.app_secret);
      if (plain) map.set(row.waba_id, [...(map.get(row.waba_id) ?? []), plain]);
    } catch {
      // Cannot be decrypted: counts as no secret.
    }
  }
  return map;
}

/**
 * Second chance for a delivery the platform secret rejected: verify it
 * against the app secrets of the tenant it names. Per-number events are
 * checked against the numbers they claim; account-level events
 * (`account_update`, no number) against the account's own rows. Reads
 * only those rows.
 */
export async function verifyTenantAppSignature(
  db: SupabaseClient,
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const claimed = extractPhoneNumberIds(rawBody);
  const wabas = extractAccountOnlyWabaIds(rawBody);
  if (claimed.length === 0 && wabas.length === 0) return false;

  if (claimed.length > 0) {
    const secrets = await loadTenantSecrets(db, claimed);
    if (!secrets) return false;
    if (!tenantSignatureDecision(rawBody, signatureHeader, secrets, claimed)) {
      return false;
    }
  }
  if (wabas.length > 0) {
    const secrets = await loadWabaSecrets(db, wabas);
    if (!secrets) return false;
    if (!wabaSignatureDecision(rawBody, signatureHeader, secrets, wabas)) {
      return false;
    }
  }
  return true;
}
