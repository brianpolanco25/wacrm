// ============================================================
// The shape of a row of `plans`, as the platform operator may write it
// (fase 9, s9.3).
//
// Two inventories live here, and they are the contract between the
// catalogue and the code that enforces it:
//
//   PLAN_LIMIT_KEYS  every key of `plans.limits` — the eight documented
//                    by the 041 seed. Three are flow counters
//                    (`USAGE_METRICS`, checked with `assertQuota`), two
//                    are stock caps (`assertStockLimit`), the rest are
//                    shown on the plan and enforced where their feature
//                    lives (or, like `contacts`, deliberately not yet).
//   PLAN_FEATURES    every string of `plans.features` the product knows,
//                    same source. Any feature string the code asks
//                    `assertPlanFeature` about must be one of these.
//
// `plan-catalog.test.ts` pins both lists against the seed AND against the
// code that reads them, so a new feature check in the code without
// its entry here fails the gate instead of shipping a feature that no
// plan can ever be given.
//
// The validation is deliberately strict: the enforcement code treats a
// MISSING limit key as unlimited (`limit === undefined → return`), so an
// editor that dropped a key would silently hand out unlimited usage.
// Every write carries all eight keys, each an integer ≥ 0 or `null`.
// ============================================================

/** Keys of `plans.limits`, in the order the editor shows them. */
export const PLAN_LIMIT_KEYS = [
  'operators',
  'contacts',
  'messages_out',
  'ai_replies',
  'broadcast_recipients',
  'knowledge_documents',
  'numbers',
  'retention_months',
] as const;

export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

/** Values of `plans.features`, in the order the editor shows them. */
export const PLAN_FEATURES = [
  'ai_autoreply',
  'ai_knowledge',
  'auto_assign',
  'api',
  'webhooks',
  'multi_number',
  'priority_support',
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

/**
 * A plan id is a slug: it is a primary key, it travels in URLs and in
 * PayPal idempotency keys, and it never changes once created.
 */
export const PLAN_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export const PLAN_NAME_MAX = 80;
export const PLAN_DESCRIPTION_MAX = 500;
/** `numeric(10,2)`: eight digits before the point. */
export const PLAN_PRICE_MAX = 99_999_999.99;
/** `plans.sort_order` is a Postgres `integer`. */
const INT4_MAX = 2_147_483_647;

/** The columns of `plans` this module writes. */
export interface PlanWrite {
  id?: string;
  name?: string;
  description?: string | null;
  price_usd_month?: number;
  price_usd_year?: number | null;
  limits?: Record<PlanLimitKey, number | null>;
  features?: PlanFeature[];
  is_public?: boolean;
  sort_order?: number;
}

export type PlanValidation =
  { ok: true; value: PlanWrite } | { ok: false; error: string };

type Mode = 'create' | 'update';

const FIELDS = [
  'id',
  'name',
  'description',
  'price_usd_month',
  'price_usd_year',
  'limits',
  'features',
  'is_public',
  'sort_order',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** A price with at most two decimals, within `numeric(10,2)`. */
function isPrice(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= PLAN_PRICE_MAX &&
    Math.abs(Math.round(value * 100) - value * 100) < 1e-6
  );
}

export function validateLimits(
  raw: unknown
):
  | { ok: true; value: Record<PlanLimitKey, number | null> }
  | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "'limits' must be an object" };
  }
  for (const key of Object.keys(raw)) {
    if (!(PLAN_LIMIT_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown limit '${key}'` };
    }
  }
  const out = {} as Record<PlanLimitKey, number | null>;
  for (const key of PLAN_LIMIT_KEYS) {
    if (!(key in raw)) {
      // Missing = unlimited for the enforcement code. Refuse it rather
      // than let a forgotten field grant it.
      return {
        ok: false,
        error: `limit '${key}' is required (use null for unlimited)`,
      };
    }
    const value = raw[key];
    if (value === null) {
      out[key] = null;
    } else if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      out[key] = value;
    } else {
      return {
        ok: false,
        error: `limit '${key}' must be an integer >= 0 or null`,
      };
    }
  }
  return { ok: true, value: out };
}

export function validateFeatures(
  raw: unknown
): { ok: true; value: PlanFeature[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "'features' must be an array" };
  }
  const seen = new Set<string>();
  for (const item of raw) {
    if (
      typeof item !== 'string' ||
      !(PLAN_FEATURES as readonly string[]).includes(item)
    ) {
      return { ok: false, error: `unknown feature '${String(item)}'` };
    }
    seen.add(item);
  }
  // Stored in the inventory's order: two edits that tick the same boxes
  // write the same array.
  return {
    ok: true,
    value: PLAN_FEATURES.filter((feature) => seen.has(feature)),
  };
}

/**
 * Validate a create (`POST`) or edit (`PATCH`) body.
 *
 * Create needs `id`, `name`, `price_usd_month`, `limits` and `features`;
 * the rest default in the database. An edit takes any subset (at least
 * one field) and may not carry an `id` at all — the id is the URL and it
 * does not change. Unknown fields are refused: `provider_plan_id_*` in
 * particular is written only by the PayPal sync.
 */
export function validatePlanInput(body: unknown, mode: Mode): PlanValidation {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  for (const key of Object.keys(body)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown field '${key}'` };
    }
  }

  const value: PlanWrite = {};

  if (mode === 'update' && 'id' in body) {
    return { ok: false, error: 'the plan id cannot be changed' };
  }
  if (mode === 'create') {
    if (typeof body.id !== 'string' || !PLAN_ID_RE.test(body.id)) {
      return {
        ok: false,
        error:
          "'id' must be a slug: a lowercase letter, then 1–31 of a-z, 0-9, _ or -",
      };
    }
    value.id = body.id;
  }

  const required = (field: string) => mode === 'create' && !(field in body);

  if ('name' in body || required('name')) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > PLAN_NAME_MAX) {
      return {
        ok: false,
        error: `'name' is required, at most ${PLAN_NAME_MAX} characters`,
      };
    }
    value.name = name;
  }

  if ('description' in body) {
    if (body.description === null) {
      value.description = null;
    } else if (typeof body.description === 'string') {
      const description = body.description.trim();
      if (description.length > PLAN_DESCRIPTION_MAX) {
        return {
          ok: false,
          error: `'description' is at most ${PLAN_DESCRIPTION_MAX} characters`,
        };
      }
      value.description = description || null;
    } else {
      return { ok: false, error: "'description' must be a string or null" };
    }
  }

  if ('price_usd_month' in body || required('price_usd_month')) {
    if (!isPrice(body.price_usd_month)) {
      return {
        ok: false,
        error:
          "'price_usd_month' must be a number >= 0 with at most 2 decimals",
      };
    }
    value.price_usd_month = body.price_usd_month;
  }

  if ('price_usd_year' in body) {
    if (body.price_usd_year !== null && !isPrice(body.price_usd_year)) {
      return {
        ok: false,
        error:
          "'price_usd_year' must be null or a number >= 0 with at most 2 decimals",
      };
    }
    value.price_usd_year = body.price_usd_year as number | null;
  }

  if ('limits' in body || required('limits')) {
    const limits = validateLimits(body.limits);
    if (!limits.ok) return limits;
    value.limits = limits.value;
  }

  if ('features' in body || required('features')) {
    const features = validateFeatures(body.features);
    if (!features.ok) return features;
    value.features = features.value;
  }

  if ('is_public' in body) {
    if (typeof body.is_public !== 'boolean') {
      return { ok: false, error: "'is_public' must be a boolean" };
    }
    value.is_public = body.is_public;
  }

  if ('sort_order' in body) {
    const order = body.sort_order;
    if (
      typeof order !== 'number' ||
      !Number.isInteger(order) ||
      Math.abs(order) > INT4_MAX
    ) {
      return { ok: false, error: "'sort_order' must be an integer" };
    }
    value.sort_order = order;
  }

  if (mode === 'update' && Object.keys(value).length === 0) {
    return { ok: false, error: 'nothing to update' };
  }

  return { ok: true, value };
}
