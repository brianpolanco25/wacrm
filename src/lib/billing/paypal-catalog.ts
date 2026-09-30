// ============================================================
// The PayPal catalogue pieces shared by the CLI bootstrap
// (`scripts/paypal-bootstrap-catalog.ts`) and the operator's sync
// (`src/lib/billing/plan-sync.ts`, s9.3).
//
// Both publish our plans as billing plans under ONE PayPal product, and
// both must name them the same way: a plan the panel creates has to look
// exactly like one the script created, on the subscriber's receipts and
// in PayPal's dashboard.
//
// Like `paypal.ts`, this module imports nothing from `@/…` and only
// TYPES from `./paypal.ts` (erased by Node's type stripping), so the
// script keeps running under plain `node scripts/…`. The PayPal client
// is injected, which is also what makes the logic testable without
// PayPal.
// ============================================================

import type { BillingCycle, CreatePlanArgs, PayPalProduct } from './paypal.ts';

/**
 * Product name registered in PayPal's catalogue when `PAYPAL_PRODUCT_NAME`
 * is unset. It shows up on the subscriber's PayPal receipts and agreement
 * page, so it carries the product's visible brand, not the repo slug.
 */
export const DEFAULT_PRODUCT_NAME = 'Cabbity CRM';

/** Description the product is created with, when it has to be created. */
export const PRODUCT_DESCRIPTION = 'CRM for WhatsApp — subscription plans';

/** The three catalogue calls both callers need. */
export interface PayPalCatalogueClient {
  listProducts(): Promise<PayPalProduct[]>;
  createProduct(name: string, description: string): Promise<PayPalProduct>;
  createPlan(args: CreatePlanArgs): Promise<{ id: string }>;
}

/** `PAYPAL_PRODUCT_NAME`, or the default. */
export function productNameFromEnv(
  value: string | undefined = process.env.PAYPAL_PRODUCT_NAME
): string {
  return value?.trim() || DEFAULT_PRODUCT_NAME;
}

/** A price as the decimal string PayPal wants: `35` → `'35.00'`. */
export function money(value: number | string): string {
  return Number(value).toFixed(2);
}

/**
 * The product our plans hang from: reused by name over the whole
 * (paginated) catalogue, created otherwise.
 */
export async function ensureProduct(
  paypal: Pick<PayPalCatalogueClient, 'listProducts' | 'createProduct'>,
  productName: string
): Promise<{ product: PayPalProduct; reused: boolean }> {
  const existing = (await paypal.listProducts()).find(
    (product) => product.name === productName
  );
  if (existing) return { product: existing, reused: true };
  return {
    product: await paypal.createProduct(productName, PRODUCT_DESCRIPTION),
    reused: false,
  };
}

/** Plan name as PayPal shows it: `Pro (monthly)`. */
export function paypalPlanName(planName: string, cycle: BillingCycle): string {
  return `${planName} (${cycle === 'year' ? 'yearly' : 'monthly'})`;
}

/** Plan description as PayPal shows it. */
export function paypalPlanDescription(
  planName: string,
  cycle: BillingCycle
): string {
  return `Cabbity CRM ${planName} plan, billed ${cycle === 'year' ? 'yearly' : 'monthly'}`;
}
