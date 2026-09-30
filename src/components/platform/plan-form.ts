// ============================================================
// The plan editor's form model (s9.3): what the inputs hold (strings,
// an «unlimited» checkbox per metric) and how it becomes the body of
// POST /api/platform/plans or PATCH /api/platform/plans/[id].
//
// Kept out of the component so it can be tested without a DOM (the repo
// has no jsdom). The server validates again, strictly; this only turns
// the form into the right JSON and catches the obvious before a round
// trip. «Unlimited» is `null`, never an empty input: an empty input is
// an error, because a missing limit would mean unlimited to the
// enforcement code.
// ============================================================

import {
  PLAN_FEATURES,
  PLAN_ID_RE,
  PLAN_LIMIT_KEYS,
  type PlanFeature,
  type PlanLimitKey,
} from '@/lib/billing/plan-catalog';

export interface LimitField {
  unlimited: boolean;
  value: string;
}

export interface PlanForm {
  id: string;
  name: string;
  description: string;
  priceMonth: string;
  priceYear: string;
  isPublic: boolean;
  sortOrder: string;
  limits: Record<PlanLimitKey, LimitField>;
  features: PlanFeature[];
}

/** What the editor needs from a plan of GET /api/platform/plans. */
export interface EditablePlan {
  id: string;
  name: string;
  description: string | null;
  priceMonth: number;
  priceYear: number | null;
  isPublic: boolean;
  sortOrder: number;
  limits: Record<string, number | null>;
  features: string[];
}

/** Error keys, under `Platform.plans.errors`. */
export type PlanFormError =
  'id' | 'name' | 'priceMonth' | 'priceYear' | 'sortOrder' | 'limit';

export function emptyPlanForm(sortOrder = 0): PlanForm {
  const limits = {} as Record<PlanLimitKey, LimitField>;
  for (const key of PLAN_LIMIT_KEYS) {
    limits[key] = { unlimited: false, value: '' };
  }
  return {
    id: '',
    name: '',
    description: '',
    priceMonth: '',
    priceYear: '',
    isPublic: false,
    sortOrder: String(sortOrder),
    limits,
    features: [],
  };
}

export function planToForm(plan: EditablePlan): PlanForm {
  const limits = {} as Record<PlanLimitKey, LimitField>;
  for (const key of PLAN_LIMIT_KEYS) {
    const value = plan.limits[key];
    limits[key] =
      value === null
        ? { unlimited: true, value: '' }
        : { unlimited: false, value: value === undefined ? '' : String(value) };
  }
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description ?? '',
    priceMonth: String(plan.priceMonth),
    priceYear: plan.priceYear === null ? '' : String(plan.priceYear),
    isPublic: plan.isPublic,
    sortOrder: String(plan.sortOrder),
    limits,
    features: PLAN_FEATURES.filter((f) => plan.features.includes(f)),
  };
}

function parsePrice(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Number(text);
}

export type FormResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: PlanFormError; field?: PlanLimitKey };

export function formToPayload(
  form: PlanForm,
  mode: 'create' | 'edit'
): FormResult {
  const body: Record<string, unknown> = {};

  if (mode === 'create') {
    const id = form.id.trim();
    if (!PLAN_ID_RE.test(id)) return { ok: false, error: 'id' };
    body.id = id;
  }

  const name = form.name.trim();
  if (!name) return { ok: false, error: 'name' };
  body.name = name;
  body.description = form.description.trim() || null;

  const month = parsePrice(form.priceMonth);
  if (month === null) return { ok: false, error: 'priceMonth' };
  body.price_usd_month = month;

  if (form.priceYear.trim() === '') {
    body.price_usd_year = null;
  } else {
    const year = parsePrice(form.priceYear);
    if (year === null) return { ok: false, error: 'priceYear' };
    body.price_usd_year = year;
  }

  body.is_public = form.isPublic;

  const order = form.sortOrder.trim();
  if (!/^-?\d+$/.test(order)) return { ok: false, error: 'sortOrder' };
  body.sort_order = Number(order);

  const limits: Record<string, number | null> = {};
  for (const key of PLAN_LIMIT_KEYS) {
    const field = form.limits[key];
    if (field.unlimited) {
      limits[key] = null;
      continue;
    }
    if (!/^\d+$/.test(field.value.trim())) {
      return { ok: false, error: 'limit', field: key };
    }
    limits[key] = Number(field.value.trim());
  }
  body.limits = limits;
  body.features = PLAN_FEATURES.filter((f) => form.features.includes(f));

  return { ok: true, body };
}
