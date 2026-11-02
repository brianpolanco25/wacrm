import crypto from 'node:crypto';

/**
 * Does `signatureHeader` (Meta's `X-Hub-Signature-256`) match `rawBody`
 * under `secret`? Pure: the caller decides which secret applies.
 */
export function signatureMatches(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!secret) return false;
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Meta signs a payload whose non-ASCII characters are escaped as
 *  lowercase `\uXXXX`; a hop that decodes them changes the bytes. */
function escapeNonAscii(s: string): string {
  return s.replace(
    /[\u0080-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

export function bodyVariants(rawBody: string): [string, string][] {
  const variants: [string, string][] = [
    ['trimmed', rawBody.trim()],
    ['unicode-escaped', escapeNonAscii(rawBody)],
  ];
  try {
    const reencoded = JSON.stringify(JSON.parse(rawBody));
    variants.push(['reserialized', reencoded]);
    variants.push(['reserialized+unicode-escaped', escapeNonAscii(reencoded)]);
  } catch {
    // Not JSON: nothing more to try.
  }
  return variants.filter(([, v]) => v !== rawBody);
}

/**
 * Like `signatureMatches`, but also tries the rewrites of the body a hop
 * between Meta and us may have made. A match is still proof the sender
 * holds the secret: an HMAC cannot be forged without it.
 * Returns the variant that matched (`'raw'` for the body as received).
 */
export function signatureMatchesAnyVariant(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): string | null {
  if (signatureMatches(rawBody, signatureHeader, secret)) return 'raw';
  for (const [name, variant] of bodyVariants(rawBody)) {
    if (signatureMatches(variant, signatureHeader, secret)) return name;
  }
  return null;
}

/**
 * Verify a webhook delivery against the platform's own Meta app
 * (`META_APP_SECRET`). Numbers connected through a tenant's own Meta
 * app sign with that app's secret instead: see
 * `verifyTenantAppSignature` in `tenant-app-secret.ts`, which the
 * webhook tries when this one says no.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    console.error(
      '[webhook] META_APP_SECRET is not set — rejecting request. ' +
        'Configure the env var (Meta → App Settings → Basic → App Secret) ' +
        'to enable signature verification.'
    );
    return false;
  }
  return signatureMatches(rawBody, signatureHeader, secret);
}
