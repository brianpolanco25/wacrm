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
    /**
     * Already-serialised request body. Takes precedence over `body`
     * and is sent byte for byte.
     *
     * The webhook verification call needs this: PayPal signed the
     * exact bytes it delivered, and `JSON.parse` + `JSON.stringify`
     * does not round-trip them (key order, number formatting, escapes
     * and whitespace all move). Re-encoding turns a genuine event into
     * a FAILURE.
     */
    rawBody?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; data: T }> {
  const payload =
    init.rawBody !== undefined
      ? init.rawBody
      : init.body === undefined
        ? undefined
        : JSON.stringify(init.body);

  const attempt = async (token: string) =>
    fetch(`${paypalBaseUrl()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      body: payload,
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

/** PayPal caps `page_size` at 20 for the catalogue listing. */
const PRODUCT_PAGE_SIZE = 20;

/**
 * Stop after this many pages (500 products). A merchant catalogue that
 * big is not ours; without the cap a provider that keeps answering full
 * pages would spin the bootstrap forever.
 */
const MAX_PRODUCT_PAGES = 25;

/**
 * Every product in the merchant catalogue, following pagination.
 *
 * The bootstrap looks its product up by name here, so a partial listing
 * would silently create a duplicate product: PayPal returns the first 20
 * products on `page=1`, and an account that had a catalogue before wacrm
 * can easily push ours past that boundary.
 */
export async function listProducts(): Promise<PayPalProduct[]> {
  const products: PayPalProduct[] = [];

  for (let page = 1; page <= MAX_PRODUCT_PAGES; page += 1) {
    const { data } = await paypalFetch<{ products?: PayPalProduct[] }>(
      `/v1/catalogs/products?page=${page}&page_size=${PRODUCT_PAGE_SIZE}&total_required=false`
    );
    const currentPage = data.products ?? [];
    products.push(...currentPage);
    // A short page is the last page; PayPal sends no next-page cursor.
    if (currentPage.length < PRODUCT_PAGE_SIZE) return products;
  }

  throw new PayPalError(
    `PayPal catalogue did not end after ${MAX_PRODUCT_PAGES} pages of ${PRODUCT_PAGE_SIZE} products`,
    0,
    null
  );
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

// ------------------------------------------------------------
// Subscriptions (used by the checkout route, Fase 3 §2).
//
// The webhook that turns an approved subscription into service lives
// in Fase 3 §3 — nothing here writes to our database.
// ------------------------------------------------------------

export interface CreateSubscriptionArgs {
  /** PayPal billing plan id (`plans.provider_plan_id_month|_year`). */
  planId: string;
  /**
   * Our own correlation id. PayPal echoes `custom_id` back on the
   * subscription resource of every event, so the webhook can resolve
   * the account even if the intent row were missing.
   */
  customId: string;
  /** Where PayPal sends the approver back. Informational page only. */
  returnUrl: string;
  /** Where PayPal sends an approver who backs out. */
  cancelUrl: string;
  /** Shown on PayPal's approval screen. */
  brandName?: string;
  /** Idempotency key sent as PayPal-Request-Id. */
  requestId: string;
}

export interface PayPalSubscription {
  id: string;
  status: string;
  /** The `rel: "approve"` link the browser must be sent to. */
  approvalUrl: string;
}

/**
 * Create a subscription in APPROVAL_PENDING state and return its
 * approval link.
 *
 * `IMMEDIATE_PAYMENT_REQUIRED` keeps eChecks out: a subscription that
 * activates days later, after a bank transfer clears, would hand out
 * service before the money is real. `NO_SHIPPING` because software has
 * no address to ship to and the extra step loses conversions.
 */
export async function createSubscription(
  args: CreateSubscriptionArgs
): Promise<PayPalSubscription> {
  const { data } = await paypalFetch<{
    id?: unknown;
    status?: unknown;
    links?: Array<{ rel?: unknown; href?: unknown }>;
  }>('/v1/billing/subscriptions', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': args.requestId },
    body: {
      plan_id: args.planId,
      custom_id: args.customId,
      application_context: {
        brand_name: args.brandName,
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        payment_method: {
          payer_selected: 'PAYPAL',
          payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED',
        },
        return_url: args.returnUrl,
        cancel_url: args.cancelUrl,
      },
    },
  });

  const id = providerId(data, 'subscription');
  const approvalUrl = approvalLink(data.links);
  if (!approvalUrl) {
    // Without it the customer cannot pay. Failing here beats handing
    // the UI a subscription it can never get approved.
    throw new PayPalError(
      `PayPal subscription ${id} came back without an approve link`,
      200,
      data
    );
  }
  const status = typeof data.status === 'string' ? data.status : 'UNKNOWN';
  return { id, status, approvalUrl };
}

/** Pick the `approve` link out of a PayPal HATEOAS `links` array. */
export function approvalLink(
  links: Array<{ rel?: unknown; href?: unknown }> | undefined
): string | null {
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    if (
      typeof link?.rel === 'string' &&
      link.rel.toLowerCase() === 'approve' &&
      typeof link.href === 'string' &&
      link.href
    ) {
      return link.href;
    }
  }
  return null;
}

// ------------------------------------------------------------
// Managing a live subscription (Fase 3 §6).
//
// Everything below acts on a subscription that already exists at
// PayPal. None of it decides anything about our own database: the
// truth still arrives as a webhook event, and the settings routes that
// call these functions never write `status = 'active'` themselves.
// ------------------------------------------------------------

/**
 * Cancel a subscription at PayPal. Idempotent from our side in the
 * sense that matters: PayPal answers 422 for a subscription that is
 * already cancelled, and the caller treats that as "already done".
 *
 * The cancellation is IMMEDIATE at PayPal — no more charges are ever
 * taken — and it is NOT reversible: there is no "uncancel". What keeps
 * serving the customer until the end of the cycle they paid for is our
 * own `cancel_at_period_end` plus `current_period_end`, which is
 * exactly what the spec's table asks for ("servicio hasta fin de
 * ciclo").
 *
 * Answers 204 with an empty body on success.
 */
export async function cancelSubscription(
  subscriptionId: string,
  reason: string
): Promise<void> {
  await paypalFetch(
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    { method: 'POST', body: { reason } }
  );
}

/**
 * Resume a SUSPENDED subscription at PayPal.
 *
 * Only meaningful for `suspended`: PayPal can activate a subscription
 * it suspended (typically after exhausting payment retries), but a
 * cancelled or expired one is the end of the line and has to be
 * contracted again. The caller decides which of the two applies —
 * `reactivateMode` in `subscription-view.ts`.
 *
 * Activating here does NOT make the account active for us. PayPal
 * emits `BILLING.SUBSCRIPTION.ACTIVATED` and the webhook of §3 is what
 * lifts the local status.
 */
export async function activateSubscription(
  subscriptionId: string,
  reason: string
): Promise<void> {
  await paypalFetch(
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/activate`,
    { method: 'POST', body: { reason } }
  );
}

export interface ReviseSubscriptionArgs {
  subscriptionId: string;
  /** The PayPal plan to move onto (`plans.provider_plan_id_*`). */
  planId: string;
  /** Where PayPal returns an approver when the change needs approval. */
  returnUrl: string;
  /** Where PayPal returns an approver who backs out. */
  cancelUrl: string;
}

export interface PayPalRevision {
  /**
   * Non-null when PayPal wants the buyer to approve the change (it
   * does for anything that raises the amount charged). Until that
   * link is followed, NOTHING has changed at PayPal.
   */
  approvalUrl: string | null;
}

/**
 * Move an existing subscription onto another plan.
 *
 * This — and not a second checkout — is how §6 changes plan: PayPal
 * has no proration, and opening a second subscription would mean two
 * of them charging the same customer at once. `revise` keeps one
 * subscription and one charge.
 *
 * Two outcomes, and the caller must handle both (the spec's table says
 * so: "no se asume cambio instantáneo"):
 *
 *   - `approvalUrl` set — the buyer has to approve at PayPal. Until
 *     they do, the subscription is untouched.
 *   - `approvalUrl` null — PayPal applied the change and will emit
 *     `BILLING.SUBSCRIPTION.UPDATED`.
 *
 * Either way the new plan only starts being charged on the next
 * renewal: no proration, as the spec states.
 */
export async function reviseSubscription(
  args: ReviseSubscriptionArgs
): Promise<PayPalRevision> {
  const { data } = await paypalFetch<{
    links?: Array<{ rel?: unknown; href?: unknown }>;
  }>(
    `/v1/billing/subscriptions/${encodeURIComponent(args.subscriptionId)}/revise`,
    {
      method: 'POST',
      body: {
        plan_id: args.planId,
        application_context: {
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
          return_url: args.returnUrl,
          cancel_url: args.cancelUrl,
        },
      },
    }
  );

  return { approvalUrl: approvalLink(data?.links) };
}

// ------------------------------------------------------------
// Webhook signature verification (Fase 3 §3).
//
// PayPal does NOT sign with HMAC. The signature is an RSA one over a
// string built from the transmission headers, the webhook id and a
// CRC32 of the raw body, checked against a certificate PayPal serves.
// Rather than reimplement that (and its certificate chain handling),
// the documented path is to hand the five `paypal-transmission-*`
// headers plus the event back to PayPal and let it answer SUCCESS or
// FAILURE. Same shape as `verifyMetaWebhookSignature`, different
// algorithm — and here the algorithm is a network call.
// ------------------------------------------------------------

/** The five headers PayPal attaches to every webhook delivery. */
export interface PayPalTransmissionHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

/**
 * Ask PayPal whether this delivery is genuine.
 *
 * `rawBody` must be the exact bytes received (`await request.text()`),
 * and the caller must have proved they parse to a plain JSON object
 * before getting here — the route does, in that order. They are
 * spliced into the verification request as a raw JSON fragment, never
 * re-serialised, because JSON.parse + JSON.stringify does not
 * round-trip what PayPal signed — see `paypalFetch`.
 *
 * Returns `true` only for an explicit `SUCCESS`. Every other answer —
 * `FAILURE`, an unexpected shape, a malformed body — is a rejection.
 * Network and HTTP failures throw `PayPalError` so the caller can tell
 * "PayPal says no" from "we could not ask"; both fail closed, but only
 * the second is worth an alert.
 */
export async function verifyWebhookSignature(
  headers: PayPalTransmissionHeaders,
  rawBody: string,
  webhookId: string
): Promise<boolean> {
  // Hand-built so `webhook_event` keeps the delivered bytes. `rawBody`
  // is one plain JSON object — the caller parses and checks that before
  // calling, which is what stops a body from closing this object early
  // and appending a `webhook_id` of its own choosing. Every other value
  // goes through JSON.stringify, so no header can break out of its
  // string either.
  const requestBody =
    '{' +
    [
      `"auth_algo":${JSON.stringify(headers.authAlgo)}`,
      `"cert_url":${JSON.stringify(headers.certUrl)}`,
      `"transmission_id":${JSON.stringify(headers.transmissionId)}`,
      `"transmission_sig":${JSON.stringify(headers.transmissionSig)}`,
      `"transmission_time":${JSON.stringify(headers.transmissionTime)}`,
      `"webhook_id":${JSON.stringify(webhookId)}`,
      `"webhook_event":${rawBody}`,
    ].join(',') +
    '}';

  const { data } = await paypalFetch<{ verification_status?: unknown }>(
    '/v1/notifications/verify-webhook-signature',
    { method: 'POST', rawBody: requestBody }
  );

  return data?.verification_status === 'SUCCESS';
}
