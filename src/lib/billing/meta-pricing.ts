// ============================================================
// Price policy of an account billed by Cabbity for Meta
// (`subscriptions.meta_pricing`, migration 076; fase 10, s10.2).
//
//   {
//     "included_messages": 7000,       // delivered messages in the fee
//     "fee_usd": 1036,                 // fixed monthly fee, used or not
//     "overage": {                     // price from message 7.001 on
//       "marketing": { "multiplier": 2.5 },        // × Meta's rate
//       "utility":   { "usd_per_message": 0.03 },  // fixed amount
//       …one entry per category of META_CATEGORIES
//     }
//   }
//
// `{}` is an account billed by Meta directly (`meta_billing = 'direct'`):
// no price at all, `parseMetaPricing` answers `value: null`.
//
// Each category takes a `multiplier`, a fixed `usd_per_message`, or both
// — and then the fixed amount WINS: that is how the operator changes the
// price per message of one account without a migration. Every category
// must be present: a missing one would leave an overage message with no
// price, and the billing never prices a message at 0.
//
// Validated by hand, in the style of `plan-catalog.ts`, NOT with zod as
// the spec says: zod is not a dependency of this package (only of
// `mcp-server/`), and the repo rule is no new dependencies.
// ============================================================

import { META_CATEGORIES, type MetaCategory } from './meta-rates';

export interface CategoryPrice {
  multiplier?: number;
  usd_per_message?: number;
}

export interface MetaPricing {
  included_messages: number;
  fee_usd: number;
  overage: Record<MetaCategory, CategoryPrice>;
}

export type MetaPricingValidation =
  { ok: true; value: MetaPricing | null } | { ok: false; error: string };

/** `numeric(10,2)` like the statement columns of s10.4. */
const USD_MAX = 99_999_999.99;
/** Generous bounds that still catch a typo (25 instead of 2.5). */
const MULTIPLIER_MAX = 100;
const PER_MESSAGE_MAX = 999.99999;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function decimals(value: number, places: number): boolean {
  const scaled = value * 10 ** places;
  return Math.abs(Math.round(scaled) - scaled) < 1e-6;
}

function isPositive(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= max
  );
}

function validateCategory(
  category: MetaCategory,
  raw: unknown
): { ok: true; value: CategoryPrice } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `overage '${category}' must be an object` };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'multiplier' && key !== 'usd_per_message') {
      return {
        ok: false,
        error: `unknown field '${key}' in overage '${category}'`,
      };
    }
  }
  const out: CategoryPrice = {};
  if ('multiplier' in raw) {
    if (!isPositive(raw.multiplier, MULTIPLIER_MAX)) {
      return {
        ok: false,
        error: `overage '${category}'.multiplier must be > 0 and <= ${MULTIPLIER_MAX}`,
      };
    }
    out.multiplier = raw.multiplier;
  }
  if ('usd_per_message' in raw) {
    const usd = raw.usd_per_message;
    if (!isPositive(usd, PER_MESSAGE_MAX) || !decimals(usd, 5)) {
      return {
        ok: false,
        error: `overage '${category}'.usd_per_message must be > 0 with at most 5 decimals`,
      };
    }
    out.usd_per_message = usd;
  }
  if (out.multiplier === undefined && out.usd_per_message === undefined) {
    return {
      ok: false,
      error: `overage '${category}' needs a multiplier or a usd_per_message`,
    };
  }
  return { ok: true, value: out };
}

/** Validate a `meta_pricing` value. `{}` is valid and means «direct». */
export function parseMetaPricing(raw: unknown): MetaPricingValidation {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'meta_pricing must be a JSON object' };
  }
  if (Object.keys(raw).length === 0) return { ok: true, value: null };

  for (const key of Object.keys(raw)) {
    if (!['included_messages', 'fee_usd', 'overage'].includes(key)) {
      return { ok: false, error: `unknown field '${key}'` };
    }
  }

  const included = raw.included_messages;
  if (
    typeof included !== 'number' ||
    !Number.isSafeInteger(included) ||
    included < 0
  ) {
    return {
      ok: false,
      error: "'included_messages' must be an integer >= 0",
    };
  }

  const fee = raw.fee_usd;
  if (
    typeof fee !== 'number' ||
    !Number.isFinite(fee) ||
    fee < 0 ||
    fee > USD_MAX ||
    !decimals(fee, 2)
  ) {
    return {
      ok: false,
      error: "'fee_usd' must be >= 0 with at most 2 decimals",
    };
  }

  const overage = raw.overage;
  if (!isPlainObject(overage)) {
    return { ok: false, error: "'overage' must be an object" };
  }
  for (const key of Object.keys(overage)) {
    if (!(META_CATEGORIES as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown category '${key}' in overage` };
    }
  }
  const prices = {} as Record<MetaCategory, CategoryPrice>;
  for (const category of META_CATEGORIES) {
    if (!(category in overage)) {
      return {
        ok: false,
        error: `overage '${category}' is required`,
      };
    }
    const result = validateCategory(category, overage[category]);
    if (!result.ok) return result;
    prices[category] = result.value;
  }

  return {
    ok: true,
    value: { included_messages: included, fee_usd: fee, overage: prices },
  };
}

export class MetaPriceMissingError extends Error {
  constructor(category: string) {
    super(`No overage price for category '${category}'`);
    this.name = 'MetaPriceMissingError';
  }
}

/**
 * Price of ONE overage message of `category` for this account, in USD.
 * The fixed `usd_per_message` wins over the multiplier; the multiplier
 * applies to Meta's rate for that message (`rateFor(...).usdPerMessage`).
 * Throws rather than answer 0 or NaN.
 */
export function priceFor(
  pricing: MetaPricing,
  category: MetaCategory,
  metaRate: number
): number {
  const price = pricing.overage[category];
  if (!price) throw new MetaPriceMissingError(category);
  if (price.usd_per_message !== undefined) return price.usd_per_message;
  if (price.multiplier === undefined) throw new MetaPriceMissingError(category);
  if (!Number.isFinite(metaRate) || metaRate <= 0) {
    throw new RangeError(
      `Meta rate for '${category}' must be > 0, got ${String(metaRate)}`
    );
  }
  return price.multiplier * metaRate;
}

/** Round to cents, the way the statement stores USD. */
export function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface PackageDelivery {
  category: MetaCategory;
  /** Meta's rate for this message (`rateFor(...).usdPerMessage`). */
  metaRate: number;
}

export interface PackageCharge {
  feeUsd: number;
  includedMessages: number;
  /** Deliveries that fell inside the package. */
  includedUsed: number;
  overageMessages: number;
  overageUsd: number;
  totalUsd: number;
}

/**
 * Fee + overage for a period's deliveries, IN DELIVERY ORDER: the first
 * `included_messages` are in the fee whatever their category, every one
 * after that is priced with `priceFor`. Spec examples (marketing in RD at
 * 0,0740, 7.000 included, fee 1.036, ×2,5): 4.000 → 1.036;
 * 9.000 → 1.036 + 2.000 × 0,0740 × 2,5 = 1.406.
 */
export function packageCharge(
  pricing: MetaPricing,
  deliveries: readonly PackageDelivery[]
): PackageCharge {
  const includedUsed = Math.min(deliveries.length, pricing.included_messages);
  let overage = 0;
  for (let i = includedUsed; i < deliveries.length; i++) {
    const d = deliveries[i];
    overage += priceFor(pricing, d.category, d.metaRate);
  }
  const overageUsd = roundUsd(overage);
  return {
    feeUsd: pricing.fee_usd,
    includedMessages: pricing.included_messages,
    includedUsed,
    overageMessages: deliveries.length - includedUsed,
    overageUsd,
    totalUsd: roundUsd(pricing.fee_usd + overageUsd),
  };
}
