// ============================================================
// PayPal webhook signature — the guard, kept apart from the HTTP call
// it delegates to (`verifyWebhookSignature` in ./paypal).
//
// Same contract as `verifyMetaWebhookSignature`
// (src/lib/whatsapp/webhook-signature.ts): **fail closed**. A missing
// `PAYPAL_WEBHOOK_ID`, a missing header, a certificate that is not
// PayPal's, a PayPal outage — all of them reject the delivery. An
// operator who forgets the variable must end up with a webhook that
// accepts nothing, never one that accepts everything: this endpoint
// hands out paid service.
// ============================================================

import {
  PayPalError,
  verifyWebhookSignature,
  type PayPalTransmissionHeaders,
} from './paypal';

/** Header names, lowercase (Fetch headers are case-insensitive). */
const HEADERS = {
  transmissionId: 'paypal-transmission-id',
  transmissionTime: 'paypal-transmission-time',
  transmissionSig: 'paypal-transmission-sig',
  certUrl: 'paypal-cert-url',
  authAlgo: 'paypal-auth-algo',
} as const;

/**
 * The five `paypal-transmission-*` headers, or null when any of them is
 * missing or blank. All five are inputs to the signature; a delivery
 * without them cannot be verified and therefore cannot be trusted.
 */
export function readTransmissionHeaders(
  headers: Headers
): PayPalTransmissionHeaders | null {
  const read = (name: string) => headers.get(name)?.trim() ?? '';

  const transmissionId = read(HEADERS.transmissionId);
  const transmissionTime = read(HEADERS.transmissionTime);
  const transmissionSig = read(HEADERS.transmissionSig);
  const certUrl = read(HEADERS.certUrl);
  const authAlgo = read(HEADERS.authAlgo);

  if (
    !transmissionId ||
    !transmissionTime ||
    !transmissionSig ||
    !certUrl ||
    !authAlgo
  ) {
    return null;
  }
  return {
    transmissionId,
    transmissionTime,
    transmissionSig,
    certUrl,
    authAlgo,
  };
}

/**
 * Is this certificate URL one PayPal could have served?
 *
 * `cert_url` arrives in an unauthenticated header and is echoed back to
 * PayPal's verifier, which fetches it. PayPal validates the host on its
 * side, so this check is belt and braces — but it is the kind of check
 * whose absence turns a header into a server-side request forgery the
 * day the provider relaxes something. https only, and a host that is
 * `paypal.com` or a subdomain of it.
 */
export function isPayPalCertUrl(certUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(certUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'paypal.com' || host.endsWith('.paypal.com');
}

/**
 * Verify a webhook delivery.
 *
 * `rawBody` must be the exact bytes of the request — `await
 * request.text()` before any `JSON.parse`. Re-serialising the event
 * changes the bytes PayPal signed and turns every genuine delivery
 * into a rejection.
 */
export async function verifyPayPalWebhook(
  rawBody: string,
  headers: Headers
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId) {
    console.error(
      '[billing/webhook] PAYPAL_WEBHOOK_ID is not set — rejecting request. ' +
        'Configure the env var (PayPal → Apps & Credentials → your app → ' +
        'Webhooks → the webhook id) to enable signature verification.'
    );
    return false;
  }

  const transmission = readTransmissionHeaders(headers);
  if (!transmission) {
    console.warn(
      '[billing/webhook] delivery without the paypal-transmission-* headers'
    );
    return false;
  }

  if (!isPayPalCertUrl(transmission.certUrl)) {
    console.warn(
      '[billing/webhook] delivery with a non-PayPal cert url:',
      transmission.certUrl
    );
    return false;
  }

  try {
    return await verifyWebhookSignature(transmission, rawBody, webhookId);
  } catch (err) {
    // "We could not ask" is not "it is genuine". PayPal retries a
    // non-2xx delivery, so failing closed here loses nothing but the
    // ability to be spoofed during an outage.
    if (err instanceof PayPalError) {
      console.error(
        '[billing/webhook] PayPal verification call failed:',
        err.status,
        err.body
      );
    } else {
      console.error('[billing/webhook] PayPal verification call failed:', err);
    }
    return false;
  }
}
