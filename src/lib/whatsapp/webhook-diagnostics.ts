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
