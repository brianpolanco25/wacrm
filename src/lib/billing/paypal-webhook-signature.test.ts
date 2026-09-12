import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The guard in front of PayPal's verification endpoint. One property
// matters: it fails closed. Whatever is missing, malformed or broken,
// the answer is "reject" — this endpoint hands out paid service, and an
// operator who forgets `PAYPAL_WEBHOOK_ID` must end up with a webhook
// that accepts nothing, never one that accepts everything.

const { verifyWebhookSignature } = vi.hoisted(() => ({
  verifyWebhookSignature: vi.fn(),
}));

vi.mock('./paypal', async () => {
  const actual = await vi.importActual<typeof import('./paypal')>('./paypal');
  return { ...actual, verifyWebhookSignature };
});

import {
  isPayPalCertUrl,
  readTransmissionHeaders,
  verifyPayPalWebhook,
} from './paypal-webhook-signature';
import { PayPalError } from './paypal';

const GOOD_HEADERS: Record<string, string> = {
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-time': '2026-03-01T10:00:00Z',
  'paypal-transmission-sig': 'sig-1',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/x',
  'paypal-auth-algo': 'SHA256withRSA',
};

function headers(overrides: Record<string, string | null> = {}): Headers {
  const h = new Headers(GOOD_HEADERS);
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) h.delete(name);
    else h.set(name, value);
  }
  return h;
}

beforeEach(() => {
  verifyWebhookSignature.mockReset();
  verifyWebhookSignature.mockResolvedValue(true);
  vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-CONFIGURED');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('readTransmissionHeaders', () => {
  it('reads all five paypal-transmission-* values', () => {
    expect(readTransmissionHeaders(headers())).toEqual({
      transmissionId: 'tx-1',
      transmissionTime: '2026-03-01T10:00:00Z',
      transmissionSig: 'sig-1',
      certUrl: 'https://api.sandbox.paypal.com/v1/notifications/certs/x',
      authAlgo: 'SHA256withRSA',
    });
  });

  it('returns null when any one of them is missing or blank', () => {
    for (const name of Object.keys(GOOD_HEADERS)) {
      expect(readTransmissionHeaders(headers({ [name]: null }))).toBeNull();
      expect(readTransmissionHeaders(headers({ [name]: '   ' }))).toBeNull();
    }
  });
});

describe('isPayPalCertUrl', () => {
  it('accepts https URLs on paypal.com and its subdomains', () => {
    expect(isPayPalCertUrl('https://api.paypal.com/certs/a')).toBe(true);
    expect(isPayPalCertUrl('https://api.sandbox.paypal.com/certs/a')).toBe(
      true
    );
    expect(isPayPalCertUrl('https://paypal.com/certs/a')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPayPalCertUrl('http://api.paypal.com/certs/a')).toBe(false);
    expect(isPayPalCertUrl('https://evil.com/certs/a')).toBe(false);
    // The classic suffix trick: a host that merely ends in the string.
    expect(isPayPalCertUrl('https://notpaypal.com/certs/a')).toBe(false);
    expect(isPayPalCertUrl('https://paypal.com.evil.com/certs/a')).toBe(false);
    expect(isPayPalCertUrl('file:///etc/passwd')).toBe(false);
    expect(isPayPalCertUrl('not a url')).toBe(false);
  });
});

describe('verifyPayPalWebhook', () => {
  it('accepts a delivery PayPal confirms', async () => {
    await expect(verifyPayPalWebhook('{"id":"WH-1"}', headers())).resolves.toBe(
      true
    );

    expect(verifyWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({ transmissionId: 'tx-1' }),
      '{"id":"WH-1"}',
      'WH-CONFIGURED'
    );
  });

  it('rejects when PAYPAL_WEBHOOK_ID is not configured', async () => {
    vi.stubEnv('PAYPAL_WEBHOOK_ID', '');

    await expect(verifyPayPalWebhook('{"id":"WH-1"}', headers())).resolves.toBe(
      false
    );
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it('rejects a delivery missing any transmission header', async () => {
    for (const name of Object.keys(GOOD_HEADERS)) {
      verifyWebhookSignature.mockClear();
      await expect(
        verifyPayPalWebhook('{"id":"WH-1"}', headers({ [name]: null }))
      ).resolves.toBe(false);
      expect(verifyWebhookSignature).not.toHaveBeenCalled();
    }
  });

  it('rejects a cert url that is not PayPal before calling out to it', async () => {
    await expect(
      verifyPayPalWebhook(
        '{"id":"WH-1"}',
        headers({ 'paypal-cert-url': 'https://evil.example/cert.pem' })
      )
    ).resolves.toBe(false);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it('rejects when PayPal says FAILURE', async () => {
    verifyWebhookSignature.mockResolvedValue(false);

    await expect(verifyPayPalWebhook('{"id":"WH-1"}', headers())).resolves.toBe(
      false
    );
  });

  it('rejects — does not fall open — when PayPal cannot be asked', async () => {
    verifyWebhookSignature.mockRejectedValue(
      new PayPalError('boom', 500, null)
    );

    await expect(verifyPayPalWebhook('{"id":"WH-1"}', headers())).resolves.toBe(
      false
    );
  });

  it('rejects when the verification call throws something unexpected', async () => {
    verifyWebhookSignature.mockRejectedValue(new TypeError('fetch failed'));

    await expect(verifyPayPalWebhook('{"id":"WH-1"}', headers())).resolves.toBe(
      false
    );
  });
});
