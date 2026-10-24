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
