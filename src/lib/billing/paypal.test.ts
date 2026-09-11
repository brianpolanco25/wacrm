import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetPayPalForTests,
  activateSubscription,
  approvalLink,
  cancelSubscription,
  reviseSubscription,
  verifyWebhookSignature,
  createPlan,
  createProduct,
  createSubscription,
  getAccessToken,
  listProducts,
  paypalBaseUrl,
  PayPalError,
} from './paypal';

// Every test drives the client through a mocked global fetch and asserts
// on the exact request PayPal would have received.
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenResponse(token = 'tok-1', expiresIn = 3600) {
  return jsonResponse({ access_token: token, expires_in: expiresIn });
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1)!;
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

beforeEach(() => {
  __resetPayPalForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('PAYPAL_ENV', 'sandbox');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('paypalBaseUrl', () => {
  it('uses the sandbox unless PAYPAL_ENV is exactly "live"', () => {
    expect(paypalBaseUrl('live')).toBe('https://api-m.paypal.com');
    expect(paypalBaseUrl('sandbox')).toBe('https://api-m.sandbox.paypal.com');
    expect(paypalBaseUrl(undefined)).toBe('https://api-m.sandbox.paypal.com');
    expect(paypalBaseUrl('LIVE')).toBe('https://api-m.sandbox.paypal.com');
  });
});

describe('getAccessToken', () => {
  it('exchanges client credentials with Basic auth and caches the token', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-A', 3600));

    const first = await getAccessToken(1_000_000);
    const second = await getAccessToken(1_000_000 + 60_000);

    expect(first).toBe('tok-A');
    expect(second).toBe('tok-A');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { url, init } = lastCall();
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + Buffer.from('client-id:client-secret').toString('base64')
    );
    expect(init.body).toBe('grant_type=client_credentials');
  });

  it('refreshes the token once it is within a minute of expiring', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('tok-A', 120))
      .mockResolvedValueOnce(tokenResponse('tok-B', 3600));

    expect(await getAccessToken(0)).toBe('tok-A');
    // 70s in: 50s left, inside the 60s margin → refresh.
    expect(await getAccessToken(70_000)).toBe('tok-B');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a PayPalError without credentials and never calls the network', async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', '');
    await expect(getAccessToken()).rejects.toBeInstanceOf(PayPalError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when PayPal rejects the credentials', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'invalid_client' }, 401)
    );
    await expect(getAccessToken()).rejects.toMatchObject({ status: 401 });
  });
});

describe('catalogue', () => {
  it('lists all product pages so the bootstrap reuses its one product', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: `PROD-${index}`,
      name: `other-${index}`,
    }));
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ products: firstPage }, 200));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ products: [{ id: 'PROD-21', name: 'wacrm' }] }, 200)
    );

    await expect(listProducts()).resolves.toEqual([
      ...firstPage,
      { id: 'PROD-21', name: 'wacrm' },
    ]);

    const [firstCatalogueCall, secondCatalogueCall] =
      fetchMock.mock.calls.slice(1);
    expect(String(firstCatalogueCall[0])).toBe(
      'https://api-m.sandbox.paypal.com/v1/catalogs/products?page=1&page_size=20&total_required=false'
    );
    const { url, init } = {
      url: String(secondCatalogueCall[0]),
      init: (secondCatalogueCall[1] ?? {}) as RequestInit,
    };
    expect(url).toBe(
      'https://api-m.sandbox.paypal.com/v1/catalogs/products?page=2&page_size=20&total_required=false'
    );
    expect(init.method).toBe('GET');
  });

  it('gives up instead of paging forever when the catalogue never ends', async () => {
    const fullPage = Array.from({ length: 20 }, (_, index) => ({
      id: `PROD-${index}`,
      name: `other-${index}`,
    }));
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/v1/oauth2/token')
        ? tokenResponse()
        : jsonResponse({ products: fullPage }, 200)
    );

    await expect(listProducts()).rejects.toBeInstanceOf(PayPalError);
    // One token request plus the 25-page cap.
    expect(fetchMock).toHaveBeenCalledTimes(26);
  });

  it('retries the catalogue request once with a fresh token after a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('stale'))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_token' }, 401))
      .mockResolvedValueOnce(tokenResponse('fresh'))
      .mockResolvedValueOnce(jsonResponse({ products: [] }));

    await expect(listProducts()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      (lastCall().init.headers as Record<string, string>).Authorization
    ).toBe('Bearer fresh');
  });

  it('creates the one service product with a stable idempotency key', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ id: 'PROD-1', name: 'wacrm' }, 201)
      );
    await expect(
      createProduct('wacrm', 'CRM for WhatsApp — subscription plans')
    ).resolves.toEqual({ id: 'PROD-1', name: 'wacrm' });
    const { url, init } = lastCall();
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/catalogs/products');
    expect((init.headers as Record<string, string>)['PayPal-Request-Id']).toBe(
      'product-wacrm'
    );
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'wacrm',
      description: 'CRM for WhatsApp — subscription plans',
      type: 'SERVICE',
      category: 'SOFTWARE',
    });
  });

  it('creates an active monthly or annual USD plan with its stable request id', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'P-ANNUAL' }, 201));
    await expect(
      createPlan({
        productId: 'PROD-1',
        name: 'Pro (yearly)',
        cycle: 'year',
        priceUsd: '790.00',
        requestId: 'wacrm-sandbox-pro-year-v1',
      })
    ).resolves.toEqual({ id: 'P-ANNUAL' });
    const { url, init } = lastCall();
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/billing/plans');
    expect((init.headers as Record<string, string>)['PayPal-Request-Id']).toBe(
      'wacrm-sandbox-pro-year-v1'
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      product_id: 'PROD-1',
      name: 'Pro (yearly)',
      status: 'ACTIVE',
      billing_cycles: [
        {
          frequency: { interval_unit: 'YEAR', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: '790.00', currency_code: 'USD' },
          },
        },
      ],
    });
  });

  it('does not let a malformed PayPal response erase a stored provider id', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({}, 201));

    await expect(
      createPlan({
        productId: 'PROD-1',
        name: 'Pro (monthly)',
        cycle: 'month',
        priceUsd: '79.00',
        requestId: 'wacrm-sandbox-pro-month-v1',
      })
    ).rejects.toBeInstanceOf(PayPalError);
  });
});

describe('createSubscription', () => {
  const args = {
    planId: 'P-PRO-MONTH',
    customId: 'acct-1',
    returnUrl: 'https://app.example.com/billing/return',
    cancelUrl: 'https://app.example.com/billing?checkout=cancelled',
    brandName: 'wacrm',
    requestId: 'checkout-acct-1-pro-month-1',
  };

  it('posts the plan with our correlation id and returns the approval link', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'I-SUB-1',
          status: 'APPROVAL_PENDING',
          links: [
            { rel: 'self', href: 'https://api/self' },
            {
              rel: 'approve',
              href: 'https://www.sandbox.paypal.com/approve/1',
            },
          ],
        },
        201
      )
    );

    await expect(createSubscription(args)).resolves.toEqual({
      id: 'I-SUB-1',
      status: 'APPROVAL_PENDING',
      approvalUrl: 'https://www.sandbox.paypal.com/approve/1',
    });

    const { url, init } = lastCall();
    expect(url).toBe(
      'https://api-m.sandbox.paypal.com/v1/billing/subscriptions'
    );
    expect(init.method).toBe('POST');
    // The idempotency key: a replayed POST must not open a second
    // subscription, which would be a second charge.
    expect((init.headers as Record<string, string>)['PayPal-Request-Id']).toBe(
      'checkout-acct-1-pro-month-1'
    );
    expect(JSON.parse(String(init.body))).toEqual({
      plan_id: 'P-PRO-MONTH',
      // Echoed back on every webhook event — how §3 finds the account.
      custom_id: 'acct-1',
      application_context: {
        brand_name: 'wacrm',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        payment_method: {
          payer_selected: 'PAYPAL',
          payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED',
        },
        return_url: 'https://app.example.com/billing/return',
        cancel_url: 'https://app.example.com/billing?checkout=cancelled',
      },
    });
  });

  it('rejects a subscription that came back without an approve link', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          { id: 'I-SUB-2', status: 'APPROVAL_PENDING', links: [] },
          201
        )
      );

    // Handing the UI a subscription nobody can approve would look like
    // a successful checkout and never become a payment.
    await expect(createSubscription(args)).rejects.toBeInstanceOf(PayPalError);
  });

  it('surfaces a PayPal refusal instead of inventing a subscription', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ name: 'UNPROCESSABLE_ENTITY' }, 422)
      );

    await expect(createSubscription(args)).rejects.toMatchObject({
      name: 'PayPalError',
      status: 422,
    });
  });
});

describe('approvalLink', () => {
  it('finds the approve rel whatever its case and position', () => {
    expect(
      approvalLink([
        { rel: 'edit', href: 'https://api/edit' },
        { rel: 'APPROVE', href: 'https://approve/me' },
      ])
    ).toBe('https://approve/me');
  });

  it('returns null when there is none', () => {
    expect(approvalLink(undefined)).toBeNull();
    expect(approvalLink([])).toBeNull();
    expect(approvalLink([{ rel: 'approve' }])).toBeNull();
  });
});

describe('verifyWebhookSignature', () => {
  const headers = {
    transmissionId: 'tx-1',
    transmissionTime: '2026-03-01T10:00:00Z',
    transmissionSig: 'sig-1',
    certUrl: 'https://api.sandbox.paypal.com/cert.pem',
    authAlgo: 'SHA256withRSA',
  };

  // The bytes PayPal signed. Key order, spacing and number formatting
  // all differ from what JSON.stringify(JSON.parse(x)) would produce,
  // which is the whole point: a re-encoded body verifies as FAILURE.
  const rawBody =
    '{ "event_type":"BILLING.SUBSCRIPTION.ACTIVATED",  "id":"WH-1",\n' +
    '  "amount": 79.00 }';

  it('sends the delivered bytes verbatim as webhook_event', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ verification_status: 'SUCCESS' }));

    await expect(
      verifyWebhookSignature(headers, rawBody, 'WH-ID')
    ).resolves.toBe(true);

    const { url, init } = lastCall();
    expect(url).toBe(
      'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature'
    );
    const sent = String(init.body);
    expect(sent).toContain(`"webhook_event":${rawBody}`);
    expect(sent).not.toBe(JSON.stringify(JSON.parse(sent)));

    // It is still valid JSON, and every header landed in its field.
    expect(JSON.parse(sent)).toMatchObject({
      auth_algo: 'SHA256withRSA',
      cert_url: 'https://api.sandbox.paypal.com/cert.pem',
      transmission_id: 'tx-1',
      transmission_sig: 'sig-1',
      transmission_time: '2026-03-01T10:00:00Z',
      webhook_id: 'WH-ID',
      webhook_event: { id: 'WH-1' },
    });
  });

  it('is false for anything that is not an explicit SUCCESS', async () => {
    for (const body of [
      { verification_status: 'FAILURE' },
      { verification_status: 'success' },
      { nothing: true },
      null,
    ]) {
      __resetPayPalForTests();
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse(body));

      await expect(
        verifyWebhookSignature(headers, '{"id":"WH-1"}', 'WH-ID')
      ).resolves.toBe(false);
    }
  });

  it('throws instead of returning false when PayPal cannot be reached', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ name: 'INTERNAL' }, 500));

    await expect(
      verifyWebhookSignature(headers, '{"id":"WH-1"}', 'WH-ID')
    ).rejects.toMatchObject({ name: 'PayPalError', status: 500 });
  });

  it('escapes a header that tries to break out of its JSON string', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ verification_status: 'FAILURE' }));

    await verifyWebhookSignature(
      { ...headers, transmissionId: '","webhook_id":"attacker' },
      '{"id":"WH-1"}',
      'WH-ID'
    );

    const parsed = JSON.parse(String(lastCall().init.body));
    expect(parsed.webhook_id).toBe('WH-ID');
    expect(parsed.transmission_id).toBe('","webhook_id":"attacker');
  });
});

// ---------------------------------------------------------------------------
// Managing a live subscription (Fase 3 §6).
// ---------------------------------------------------------------------------

describe('cancelSubscription', () => {
  it('posts the cancel action with a reason and accepts an empty 204', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      cancelSubscription('I-SUB-1', 'Cancelled by the customer')
    ).resolves.toBeUndefined();

    const { url, init } = lastCall();
    expect(url).toBe(
      'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-SUB-1/cancel'
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      reason: 'Cancelled by the customer',
    });
  });

  it('escapes the subscription id into the path', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    // The id reaches us from our own database, but building a URL by
    // concatenation is how a path traversal gets in later.
    await cancelSubscription('I-SUB/../../oops', 'r');
    expect(lastCall().url).toContain('I-SUB%2F..%2F..%2Foops');
  });

  it('surfaces a PayPal refusal instead of pretending it cancelled', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ name: 'UNPROCESSABLE_ENTITY' }, 422)
      );
    await expect(cancelSubscription('I-SUB-1', 'r')).rejects.toBeInstanceOf(
      PayPalError
    );
  });
});

describe('activateSubscription', () => {
  it('posts the activate action', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await activateSubscription('I-SUB-1', 'Back in business');
    const { url, init } = lastCall();
    expect(url).toBe(
      'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-SUB-1/activate'
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      reason: 'Back in business',
    });
  });
});

describe('reviseSubscription', () => {
  it('moves the SAME subscription onto another plan', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ plan_id: 'P-NEG-MONTH', links: [] })
      );

    const revision = await reviseSubscription({
      subscriptionId: 'I-SUB-1',
      planId: 'P-NEG-MONTH',
      returnUrl: 'https://app.example.com/billing/return',
      cancelUrl: 'https://app.example.com/billing?checkout=cancelled',
    });

    const { url, init } = lastCall();
    // Not POST /v1/billing/subscriptions: a second subscription would
    // charge the customer twice, which is the whole point of revising.
    expect(url).toBe(
      'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-SUB-1/revise'
    );
    const body = JSON.parse(String(init.body));
    expect(body.plan_id).toBe('P-NEG-MONTH');
    expect(body.application_context.return_url).toBe(
      'https://app.example.com/billing/return'
    );
    expect(revision.approvalUrl).toBeNull();
  });

  it('reports the approval link when PayPal needs the buyer to approve', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        plan_id: 'P-NEG-MONTH',
        links: [
          { rel: 'self', href: 'https://api-m.sandbox.paypal.com/x' },
          { rel: 'approve', href: 'https://www.sandbox.paypal.com/approve/9' },
        ],
      })
    );
    const revision = await reviseSubscription({
      subscriptionId: 'I-SUB-1',
      planId: 'P-NEG-MONTH',
      returnUrl: 'https://app.example.com/billing/return',
      cancelUrl: 'https://app.example.com/billing',
    });
    expect(revision.approvalUrl).toBe(
      'https://www.sandbox.paypal.com/approve/9'
    );
  });

  it('surfaces a refusal rather than reporting a change that did not happen', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ name: 'UNPROCESSABLE_ENTITY' }, 422)
      );
    await expect(
      reviseSubscription({
        subscriptionId: 'I-SUB-1',
        planId: 'P-NEG-MONTH',
        returnUrl: 'https://app.example.com/billing/return',
        cancelUrl: 'https://app.example.com/billing',
      })
    ).rejects.toBeInstanceOf(PayPalError);
  });
});
