import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetPayPalForTests,
  createPlan,
  createProduct,
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
  it('lists existing products so the bootstrap reuses its one product', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse(
        {
          products: [{ id: 'PROD-1', name: 'wacrm' }],
        },
        200
      )
    );

    await expect(listProducts()).resolves.toEqual([
      { id: 'PROD-1', name: 'wacrm' },
    ]);

    const { url, init } = lastCall();
    expect(url).toBe(
      'https://api-m.sandbox.paypal.com/v1/catalogs/products?page_size=20&total_required=false'
    );
    expect(init.method).toBe('GET');
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
