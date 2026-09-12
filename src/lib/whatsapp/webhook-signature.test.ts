import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyMetaWebhookSignature } from './webhook-signature';

const SECRET = process.env.META_APP_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

describe('verifyMetaWebhookSignature', () => {
  it('accepts a request signed with the correct secret', () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account' });
    expect(verifyMetaWebhookSignature(body, signedHeader(body))).toBe(true);
  });

  it('rejects a signature computed with a different secret', () => {
    const body = '{}';
    expect(verifyMetaWebhookSignature(body, signedHeader(body, 'wrong'))).toBe(
      false
    );
  });

  it('rejects when the body has been tampered with after signing', () => {
    const original = '{"entry":[]}';
    const header = signedHeader(original);
    const tampered = '{"entry":[{"id":"injected"}]}';
    expect(verifyMetaWebhookSignature(tampered, header)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyMetaWebhookSignature('anything', null)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const body = '{}';
    const hex = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyMetaWebhookSignature(body, hex)).toBe(false);
    expect(verifyMetaWebhookSignature(body, `sha512=${hex}`)).toBe(false);
  });

  it('rejects a header of the wrong length without throwing', () => {
    // timingSafeEqual would throw on length mismatch — the guard inside
    // the verifier should catch this and return false instead.
    expect(verifyMetaWebhookSignature('{}', 'sha256=tooshort')).toBe(false);
  });

  // ------------------------------------------------------------
  // Fase 4 §1, criterion 3: "signature verification works with OUR
  // app's secret for every tenant".
  //
  // The function never reads the database — and that is exactly the
  // property worth pinning. In platform mode every tenant's WABA is
  // subscribed to OUR app (step 6 of the signup), Meta signs each
  // delivery with the secret of the app that owns the subscription, so
  // one secret verifies all of them. The incoherence the spec describes
  // (a global secret against per-tenant app tokens) disappears by
  // construction rather than by a code change here.
  // ------------------------------------------------------------
  describe('one app secret, every tenant', () => {
    /** An inbound delivery as Meta sends it, for one tenant's number. */
    const deliveryFor = (phoneNumberId: string) =>
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: `waba-${phoneNumberId}`,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: phoneNumberId },
                  messages: [{ id: 'wamid.1', from: '15550001111' }],
                },
              },
            ],
          },
        ],
      });

    it('accepts deliveries for two different tenants with the same secret', () => {
      const tenantA = deliveryFor('pn-tenant-a');
      const tenantB = deliveryFor('pn-tenant-b');

      expect(verifyMetaWebhookSignature(tenantA, signedHeader(tenantA))).toBe(
        true
      );
      expect(verifyMetaWebhookSignature(tenantB, signedHeader(tenantB))).toBe(
        true
      );
    });

    it("rejects a delivery signed with a tenant's own app secret", () => {
      // The migration consequence, asserted rather than assumed: a row
      // left over from a self-hosted install carries a token minted by
      // the CUSTOMER's Meta app, and Meta signs its webhooks with that
      // app's secret. Those deliveries fail loudly (401 in the route)
      // until the tenant reconnects through the dialog. That is the
      // correct outcome, and it is documented as a migration step.
      const body = deliveryFor('pn-legacy-tenant');
      expect(
        verifyMetaWebhookSignature(body, signedHeader(body, 'tenant-own-app'))
      ).toBe(false);
    });
  });

  describe('fail-closed when secret is missing', () => {
    const originalSecret = process.env.META_APP_SECRET;
    beforeEach(() => {
      delete process.env.META_APP_SECRET;
    });
    afterEach(() => {
      process.env.META_APP_SECRET = originalSecret;
    });

    it('rejects even a correctly-formed signature when no secret is configured', () => {
      const body = '{}';
      // Use the original secret to produce the header so we can verify
      // the rejection is solely due to missing config.
      const header = signedHeader(body, originalSecret!);
      expect(verifyMetaWebhookSignature(body, header)).toBe(false);
    });
  });
});
