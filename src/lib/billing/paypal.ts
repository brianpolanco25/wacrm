// ============================================================
// PayPal REST client — catalogue operations over plain `fetch`. No SDK:
// the official SDK is deprecated and the catalogue surface is small.
//
// Configuration (all server-side, read lazily at call time so tests can
// set them per case):
//   PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET  OAuth2 client credentials
//   PAYPAL_ENV                               'sandbox' | 'live' (default sandbox —
//                                            an unset env must never hit live)
// Token: one OAuth2 access token cached in module memory with its
// expiry; refreshed a minute early and on the first 401 response.
//
// This module deliberately imports nothing from `@/…` so that
// `scripts/paypal-bootstrap-catalog.ts` can run it under plain Node
// (`node scripts/…`, Node 24 type-stripping) without path aliases.
// ============================================================

export type PayPalEnv = 'sandbox' | 'live';
export type BillingCycle = 'month' | 'year';

const BASE_URLS: Record<PayPalEnv, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

/** Resolve the API base URL. Anything that is not exactly 'live' is sandbox. */
export function paypalBaseUrl(
  env: string | undefined = process.env.PAYPAL_ENV
): string {
  return BASE_URLS[env === 'live' ? 'live' : 'sandbox'];
}

export class PayPalError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.body = body;
  }
}

// ------------------------------------------------------------
// OAuth2 token (cached)
// ------------------------------------------------------------

interface CachedToken {
  token: string;
  /** Epoch ms after which the token must not be used. */
  expiresAt: number;
}

let cached: CachedToken | null = null;

/** Safety margin: refresh this long before PayPal says the token dies. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export function __resetPayPalForTests(): void {
  cached = null;
}

function credentials(): { id: string; secret: string } {
  const id = process.env.PAYPAL_CLIENT_ID?.trim();
  const secret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!id || !secret) {
    throw new PayPalError(
      'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not configured',
      0,
      null
    );
  }
  return { id, secret };
}

export async function getAccessToken(
  now: number = Date.now()
): Promise<string> {
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
    return cached.token;
  }
  const { id, secret } = credentials();
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const body = await readJson(res);
  if (!res.ok) {
    throw new PayPalError(
      `PayPal OAuth failed (${res.status})`,
      res.status,
      body
    );
  }
  const token = (body as { access_token?: unknown })?.access_token;
  const expiresIn = Number((body as { expires_in?: unknown })?.expires_in);
  if (typeof token !== 'string' || !token) {
    throw new PayPalError(
      'PayPal OAuth returned no access_token',
      res.status,
      body
    );
  }
  cached = {
    token,
    expiresAt:
      now +
      (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000,
  };
  return token;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Authenticated JSON request. Retries exactly once with a fresh token
 * when PayPal answers 401 (expired/revoked token). Any other non-2xx
 * becomes a `PayPalError` carrying PayPal's body for the logs.
 */
export async function paypalFetch<T = unknown>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; data: T }> {
  const attempt = async (token: string) =>
    fetch(`${paypalBaseUrl()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  let res = await attempt(await getAccessToken());
  if (res.status === 401) {
    cached = null;
    res = await attempt(await getAccessToken());
  }
  const data = await readJson(res);
  if (!res.ok) {
    throw new PayPalError(
      `PayPal ${init.method ?? 'GET'} ${path} failed (${res.status})`,
      res.status,
      data
    );
  }
  return { status: res.status, data: data as T };
}

// ------------------------------------------------------------
// Catalogue (used by scripts/paypal-bootstrap-catalog.ts).
// Checkout and webhook APIs deliberately belong to later Fase 3 features.
// ------------------------------------------------------------

export interface PayPalProduct {
  id: string;
  name: string;
}

export async function listProducts(): Promise<PayPalProduct[]> {
  const { data } = await paypalFetch<{ products?: PayPalProduct[] }>(
    '/v1/catalogs/products?page_size=20&total_required=false'
  );
  return data.products ?? [];
}

export async function createProduct(
  name: string,
  description: string
): Promise<PayPalProduct> {
  const { data } = await paypalFetch<PayPalProduct>('/v1/catalogs/products', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `product-${name}` },
    body: { name, description, type: 'SERVICE', category: 'SOFTWARE' },
  });
  return { ...data, id: providerId(data, 'product') };
}

export interface CreatePlanArgs {
  productId: string;
  name: string;
  description?: string;
  cycle: BillingCycle;
  /** Price as a decimal string, e.g. '79.00'. */
  priceUsd: string;
  /** Idempotency key sent as PayPal-Request-Id. */
  requestId: string;
}

export async function createPlan(
  args: CreatePlanArgs
): Promise<{ id: string }> {
  const { data } = await paypalFetch<{ id: string }>('/v1/billing/plans', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': args.requestId },
    body: {
      product_id: args.productId,
      name: args.name,
      description: args.description,
      status: 'ACTIVE',
      billing_cycles: [
        {
          frequency: {
            interval_unit: args.cycle === 'year' ? 'YEAR' : 'MONTH',
            interval_count: 1,
          },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: args.priceUsd, currency_code: 'USD' },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
    },
  });
  return { id: providerId(data, 'plan') };
}

function providerId(data: unknown, resource: string): string {
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) {
    throw new PayPalError(
      `PayPal created a ${resource} without an id`,
      200,
      data
    );
  }
  return id;
}
