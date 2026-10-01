// ============================================================
// The price form of a managed account (fase 10, s10.3), without React:
// what the operator types ↔ the `meta_pricing` the API takes.
//
// Every category is priced one way on screen — a multiplier of Meta's
// rate or a fixed USD amount. A stored category that has both shows the
// fixed amount (it is the one that wins, `priceFor`), and saving it
// keeps only that one. The final word is `parseMetaPricing`, the same
// validator the routes run.
// ============================================================

import { META_CATEGORIES, type MetaCategory } from '@/lib/billing/meta-rates';
import {
  parseMetaPricing,
  type CategoryPrice,
  type MetaPricing,
} from '@/lib/billing/meta-pricing';

export type PriceMode = 'multiplier' | 'usd';

export interface CategoryField {
  mode: PriceMode;
  value: string;
}

export interface PricingForm {
  included: string;
  fee: string;
  overage: Record<MetaCategory, CategoryField>;
}

export type PaymentMethodChoice = 'manual' | 'paypal';

/** What the «Asignar plan» form adds for a plan with a price policy. */
export interface ManagedTermsForm {
  paymentMethod: PaymentMethodChoice;
  /** «Meta lo paga Cabbity» → `meta_billing = 'managed'`. */
  managed: boolean;
  pricing: PricingForm;
}

function categoryField(price: CategoryPrice | undefined): CategoryField {
  if (price?.usd_per_message !== undefined) {
    return { mode: 'usd', value: String(price.usd_per_message) };
  }
  if (price?.multiplier !== undefined) {
    return { mode: 'multiplier', value: String(price.multiplier) };
  }
  return { mode: 'multiplier', value: '' };
}

/** A stored policy (or `{}` / garbage → empty fields) as the form. */
export function pricingToForm(raw: unknown): PricingForm {
  const parsed = parseMetaPricing(raw ?? {});
  const pricing = parsed.ok ? parsed.value : null;
  const overage = {} as Record<MetaCategory, CategoryField>;
  for (const category of META_CATEGORIES) {
    overage[category] = categoryField(pricing?.overage[category]);
  }
  return {
    included: pricing ? String(pricing.included_messages) : '',
    fee: pricing ? String(pricing.fee_usd) : '',
    overage,
  };
}

/** The defaults of a plan's policy: paid by hand, Cabbity pays Meta. */
export function termsFromPlan(planPricing: unknown): ManagedTermsForm {
  return {
    paymentMethod: 'manual',
    managed: true,
    pricing: pricingToForm(planPricing),
  };
}

/** `'2,5'` and `' 2.5 '` → 2.5; anything else → NaN. */
function toNumber(raw: string): number {
  const text = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return Number.NaN;
  return Number(text);
}

export type PricingResult =
  { ok: true; value: MetaPricing } | { ok: false; error: string };

/** The form as a `meta_pricing` value, validated like the server does. */
export function formToPricing(form: PricingForm): PricingResult {
  const overage: Record<string, CategoryPrice> = {};
  for (const category of META_CATEGORIES) {
    const field = form.overage[category];
    const value = toNumber(field.value);
    overage[category] =
      field.mode === 'usd' ? { usd_per_message: value } : { multiplier: value };
  }
  const parsed = parseMetaPricing({
    included_messages: toNumber(form.included),
    fee_usd: toNumber(form.fee),
    overage,
  });
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: false, error: 'empty price' };
  return { ok: true, value: parsed.value };
}

/** The body of `POST /api/platform/accounts/[id]/plan` for these terms. */
export function termsBody(
  terms: ManagedTermsForm
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!terms.managed) {
    return {
      ok: true,
      body: { paymentMethod: terms.paymentMethod, metaBilling: 'direct' },
    };
  }
  const pricing = formToPricing(terms.pricing);
  if (!pricing.ok) return pricing;
  return {
    ok: true,
    body: {
      paymentMethod: terms.paymentMethod,
      metaBilling: 'managed',
      metaPricing: pricing.value,
    },
  };
}
