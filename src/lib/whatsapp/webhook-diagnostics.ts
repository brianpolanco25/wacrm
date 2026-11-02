import type { SupabaseClient } from '@supabase/supabase-js';
import { extractPhoneNumberIds, loadTenantSecrets } from './tenant-app-secret';
import { bodyVariants, signatureMatches } from './webhook-signature';

/**
 * What the log says about a delivery the webhook just rejected.
 *
 * «invalid signature» alone cannot tell a wrong secret from a body that
 * was altered before it reached us, or from a number with no secret at
 * all. This adds the facts that separate those cases — never a secret,
 * never message content.
 */
export interface RejectedDeliveryReport {
  phoneNumberIds: string[];
  entryIds: string[];
  fields: string[];
  bodyBytes: number;
  signature: 'missing' | 'not-sha256' | 'sha256';
  /** Per claimed number: does the row exist with a usable secret? */
  hasSecret: Record<string, boolean>;
  /**
   * Which rewrite of the body the stored secret DOES sign, if any.
   * `null` means no variant matched: the secret itself differs from
   * the one Meta signs with.
   */
  matchesVariant: string | null;
}

export function describeRejectedDelivery(
  rawBody: string,
  signatureHeader: string | null,
  secretsByNumber: ReadonlyMap<string, string | null>
): RejectedDeliveryReport {
  let parsed: {
    entry?: { id?: unknown; changes?: { field?: unknown }[] }[];
  } = {};
  try {
    parsed = JSON.parse(rawBody) ?? {};
  } catch {
    // Reported below as empty ids/fields.
  }
  const entryIds: string[] = [];
  const fields: string[] = [];
  for (const entry of parsed.entry ?? []) {
    if (typeof entry?.id === 'string') entryIds.push(entry.id);
    for (const change of entry?.changes ?? []) {
      if (typeof change?.field === 'string' && !fields.includes(change.field)) {
        fields.push(change.field);
      }
    }
  }

  const phoneNumberIds = extractPhoneNumberIds(rawBody);
  const hasSecret: Record<string, boolean> = {};
  for (const id of phoneNumberIds)
    hasSecret[id] = Boolean(secretsByNumber.get(id));

  let matchesVariant: string | null = null;
  const secrets = phoneNumberIds
    .map((id) => secretsByNumber.get(id))
    .filter((s): s is string => Boolean(s));
  outer: for (const [name, variant] of bodyVariants(rawBody)) {
    for (const secret of secrets) {
      if (signatureMatches(variant, signatureHeader, secret)) {
        matchesVariant = name;
        break outer;
      }
    }
  }

  return {
    phoneNumberIds,
    entryIds,
    fields,
    bodyBytes: Buffer.byteLength(rawBody),
    signature: !signatureHeader
      ? 'missing'
      : signatureHeader.startsWith('sha256=')
        ? 'sha256'
        : 'not-sha256',
    hasSecret,
    matchesVariant,
  };
}

/** Never throws: a failing diagnostic must not change the 401. */
export async function logRejectedDelivery(
  db: SupabaseClient,
  rawBody: string,
  signatureHeader: string | null
): Promise<void> {
  try {
    const claimed = extractPhoneNumberIds(rawBody);
    const secrets =
      (claimed.length > 0 ? await loadTenantSecrets(db, claimed) : null) ??
      new Map<string, string | null>();
    console.warn(
      '[webhook] rejected delivery detail:',
      JSON.stringify(
        describeRejectedDelivery(rawBody, signatureHeader, secrets)
      )
    );
  } catch (err) {
    console.warn(
      '[webhook] could not describe the rejected delivery:',
      err instanceof Error ? err.message : err
    );
  }
}

// ------------------------------------------------------------------
// The «Test» button of the Meta app dashboard (feature 1651, R26–R28)
// ------------------------------------------------------------------

/** `entry[].id` of the sample payloads the Meta dashboard sends. */
export const META_TEST_ENTRY_ID = '0';
/** `metadata.phone_number_id` of those same sample payloads. */
export const META_TEST_PHONE_NUMBER_ID = '123456123';

interface TestDeliveryShape {
  entry?: {
    id?: unknown;
    changes?: {
      field?: unknown;
      value?: { metadata?: { phone_number_id?: unknown } };
    }[];
  }[];
}

function parseDeliveryBody(body: unknown): TestDeliveryShape | null {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as TestDeliveryShape)
        : null;
    } catch {
      return null;
    }
  }
  return body && typeof body === 'object' ? (body as TestDeliveryShape) : null;
}

/**
 * True for the sample delivery of the Meta dashboard's «Test» button:
 * at least one entry, every entry with id "0" (a real WABA id never is),
 * and every `metadata.phone_number_id` present equal to "123456123".
 * Those samples are signed with no secret this platform stores, so
 * without this they read as signature failures in the log.
 * Accepts the raw body or the already-parsed object; never throws.
 */
export function isMetaPanelTestDelivery(body: unknown): boolean {
  const parsed = parseDeliveryBody(body);
  const entries = parsed?.entry;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  for (const entry of entries) {
    if (!entry || entry.id !== META_TEST_ENTRY_ID) return false;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const id = change?.value?.metadata?.phone_number_id;
      if (id !== undefined && id !== META_TEST_PHONE_NUMBER_ID) return false;
    }
  }
  return true;
}

/** What the log says about a dashboard test delivery: field names only. */
export function describeTestDelivery(
  body: unknown,
  verified: boolean
): { verified: boolean; fields: string[] } {
  const fields: string[] = [];
  for (const entry of parseDeliveryBody(body)?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (typeof change?.field === 'string' && !fields.includes(change.field)) {
        fields.push(change.field);
      }
    }
  }
  return { verified, fields };
}
