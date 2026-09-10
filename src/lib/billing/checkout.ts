// ============================================================
// Checkout helpers — the decisions `POST /api/billing/checkout` has to
// make, kept pure so they can be tested without PayPal or Supabase.
//
// The rule that shapes this whole file (docs/saas/fase-3-facturacion.md
// §2): **the truth comes from the webhook, not from the redirect back**.
// Nothing here writes to `subscriptions`, and nothing here treats the
// customer's return from PayPal as proof of payment.
// ============================================================

import type { BillingCycle } from './paypal';

/** The subset of a `plans` row the checkout needs. */
export interface CheckoutPlanRow {
  id: string;
  name: string;
  is_public: boolean;
  price_usd_month: number | string | null;
  price_usd_year: number | string | null;
  provider_plan_id_month: string | null;
  provider_plan_id_year: string | null;
}

/** The subset of a `subscriptions` row the checkout needs. */
export interface CheckoutSubscriptionRow {
  status: string;
  provider_subscription_id: string | null;
}

export function isBillingCycle(value: unknown): value is BillingCycle {
  return value === 'month' || value === 'year';
}

/**
 * The PayPal plan id for this cycle, or null when the catalogue has no
 * plan for it yet (`scripts/paypal-bootstrap-catalog.ts` never ran, or
 * the tier has no yearly price). The route answers 409, not 500: it is
 * a configuration gap, not a bug in the request.
 */
export function providerPlanIdFor(
  plan: CheckoutPlanRow,
  cycle: BillingCycle
): string | null {
  const id =
    cycle === 'year' ? plan.provider_plan_id_year : plan.provider_plan_id_month;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** Advertised price for this cycle, as a decimal string, or null. */
export function priceFor(
  plan: CheckoutPlanRow,
  cycle: BillingCycle
): string | null {
  const raw = cycle === 'year' ? plan.price_usd_year : plan.price_usd_month;
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value.toFixed(2);
}

/**
 * Statuses that mean "this account already pays us through the
 * provider". Contracting again would open a second PayPal subscription
 * and charge the customer twice — PayPal has no prorating and no
 * plan-swap in place, so moving between plans is a Fase 3 §6 flow, not
 * a second checkout.
 *
 * `trialing`, `cancelled` and `expired` are deliberately absent: those
 * accounts have nothing being charged and must be able to contract.
 */
const CONTRACTED_STATUSES = new Set(['active', 'past_due', 'suspended']);

export function alreadyContracted(
  subscription: CheckoutSubscriptionRow | null | undefined
): boolean {
  if (!subscription) return false;
  if (!subscription.provider_subscription_id) return false;
  return CONTRACTED_STATUSES.has(subscription.status);
}

/**
 * Idempotency key for `POST /v1/billing/subscriptions`.
 *
 * PayPal replays the original response for a repeated
 * `PayPal-Request-Id`, so bucketing by ten minutes turns a double
 * click — or a retry after a dropped connection — into the *same*
 * pending subscription instead of two, which is the difference between
 * one charge and two if the customer approves both tabs. A genuinely
 * new attempt half an hour later gets a fresh key.
 */
export function checkoutRequestId(
  accountId: string,
  planId: string,
  cycle: BillingCycle,
  now: number = Date.now()
): string {
  const bucket = Math.floor(now / (10 * 60 * 1000));
  return `checkout-${accountId}-${planId}-${cycle}-${bucket}`;
}

/**
 * Where PayPal sends the customer back.
 *
 * Both pages are informational. `return_url` in particular activates
 * nothing: it renders "we are confirming your payment" and polls, and
 * the account only gains service when the webhook says so.
 */
export function checkoutUrls(origin: string): {
  returnUrl: string;
  cancelUrl: string;
} {
  const base = origin.replace(/\/+$/, '');
  return {
    returnUrl: `${base}/billing/return`,
    cancelUrl: `${base}/billing?checkout=cancelled`,
  };
}

/**
 * The origin PayPal must send the customer back to.
 *
 * `NEXT_PUBLIC_SITE_URL` first — the deployment's canonical address,
 * the same variable the invite links use. Without it we fall back to
 * the proxy headers and finally to the request's own origin. There is
 * deliberately **no** marketing-domain fallback (the invite route has
 * one): a return URL that lands off this deployment leaves the customer
 * staring at a 404 right after paying.
 *
 * A spoofed `Host` only redirects the attacker's own browser to their
 * own site — the return page carries no secret and grants no service —
 * so this resolution is not a privilege boundary. It is still worth
 * setting `NEXT_PUBLIC_SITE_URL` in production so the link is stable.
 */
export function resolveAppOrigin(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  if (forwardedHost) {
    const proto =
      request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
      'https';
    return `${proto}://${forwardedHost}`;
  }

  const host = request.headers.get('host')?.trim();
  if (host) {
    const proto = new URL(request.url).protocol.replace(':', '');
    return `${proto}://${host}`;
  }

  return new URL(request.url).origin;
}
