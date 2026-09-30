// ============================================================
// The plan catalogue as the platform operator sees it, and its sync
// with PayPal (fase 9, s9.3).
//
// THE RULE PAYPAL IMPOSES
// -----------------------
// A PayPal billing plan with subscribers cannot have its price
// rewritten. So a price change on our side is published as a NEW PayPal
// plan: `plans.provider_plan_id_<cycle>` moves to the new id, and the old
// id is kept in `plan_provider_history` with the price it was created at.
// Existing subscribers stay on the old PayPal plan at the old price —
// decision 5 of the human, same criterion as migration 065. Nothing here
// moves a subscriber.
//
// SYNC STATE, PER PLAN AND CYCLE
// ------------------------------
//   unpublished      no PayPal id for the cycle.
//   synced           the id has an open history row (no `replaced_at`)
//                    whose price equals the price in `plans`.
//   price_mismatch   it has one, and the price differs: publishing will
//                    create a new PayPal plan.
//   unknown          an id with no open history row for it — one the CLI
//                    bootstrap created before this table existed, or one
//                    set by hand. The UI says «verificar»; a sync reads
//                    the plan back from PayPal (`getPlan`) and records
//                    what it really charges before deciding.
//
// THE ORDER OF THE WRITES
// -----------------------
// PayPal call → `plans` → history. Chosen so a crash anywhere heals on
// the next sync instead of stranding a plan:
//   - crash after PayPal, before `plans`: the retry sends the same
//     PayPal-Request-Id (it depends only on the plan, cycle, price and
//     how many history rows exist) and PayPal answers with the plan it
//     already made — no orphan;
//   - crash after `plans`, before the history row: the id is now
//     «unknown», and the next sync reads its price back from PayPal.
//
// ISOLATION
// ---------
// Service role. `plans` and `plan_provider_history` have no account_id:
// they are the global price list, not tenant data, and neither has a
// client write policy (041, 070). Every query here is keyed by the plan
// id it was given, never unfiltered, except the two catalogue-wide reads
// of the operator's listing. Callers are the `/api/platform/plans/*`
// routes, all behind `requirePlatformAdmin()`.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';

import {
  createPlan,
  createProduct,
  getPlan,
  listProducts,
  PayPalError,
  type BillingCycle,
  type PayPalEnv,
  type PayPalPlanPrice,
} from './paypal';
import {
  ensureProduct,
  money,
  paypalPlanDescription,
  paypalPlanName,
  productNameFromEnv,
  type PayPalCatalogueClient,
} from './paypal-catalog';

export const CYCLES: readonly BillingCycle[] = ['month', 'year'];

export type SyncState = 'unpublished' | 'synced' | 'price_mismatch' | 'unknown';

/** Every column of `plans` the panel reads. */
export const PLAN_COLUMNS =
  'id, name, description, price_usd_month, price_usd_year, limits, features, is_public, sort_order, created_at, updated_at, provider_plan_id_month, provider_plan_id_year';

const HISTORY_COLUMNS =
  'id, plan_id, cycle, provider, provider_plan_id, price_usd, provider_env, created_at, replaced_at, replaced_by, created_by';

export interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  price_usd_month: number | string;
  price_usd_year: number | string | null;
  limits: Record<string, number | null> | null;
  features: string[] | null;
  is_public: boolean;
  sort_order: number;
  created_at: string | null;
  updated_at: string | null;
  provider_plan_id_month: string | null;
  provider_plan_id_year: string | null;
}

export interface HistoryRow {
  id: string;
  plan_id: string;
  cycle: BillingCycle;
  provider: string;
  provider_plan_id: string;
  price_usd: number | string;
  provider_env: PayPalEnv;
  created_at: string;
  replaced_at: string | null;
  replaced_by: string | null;
  created_by: string | null;
}

export interface CycleSync {
  state: SyncState;
  providerPlanId: string | null;
  /** Price the current PayPal id was created at, when we know it. */
  syncedPrice: string | null;
}

export interface HistoryEntry {
  id: string;
  cycle: BillingCycle;
  providerPlanId: string;
  priceUsd: string;
  providerEnv: PayPalEnv;
  createdAt: string;
  replacedAt: string | null;
}

export interface PlatformPlan {
  id: string;
  name: string;
  description: string | null;
  priceMonth: number;
  priceYear: number | null;
  limits: Record<string, number | null>;
  features: string[];
  isPublic: boolean;
  sortOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
  sync: Record<BillingCycle, CycleSync>;
  history: HistoryEntry[];
}

// ------------------------------------------------------------
// Pure: state
// ------------------------------------------------------------

/** `PAYPAL_ENV`, with the same default as the client: not 'live' → sandbox. */
export function currentPayPalEnv(
  value: string | undefined = process.env.PAYPAL_ENV
): PayPalEnv {
  return value === 'live' ? 'live' : 'sandbox';
}

export function paypalConfigured(): boolean {
  return Boolean(
    process.env.PAYPAL_CLIENT_ID?.trim() &&
    process.env.PAYPAL_CLIENT_SECRET?.trim()
  );
}

function providerIdOf(plan: PlanRow, cycle: BillingCycle): string | null {
  const id =
    cycle === 'year' ? plan.provider_plan_id_year : plan.provider_plan_id_month;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** The price to publish for a cycle, or null when it is empty or 0. */
export function publishablePrice(
  plan: PlanRow,
  cycle: BillingCycle
): string | null {
  const raw = cycle === 'year' ? plan.price_usd_year : plan.price_usd_month;
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return money(value);
}

/** The open history row that vouches for THIS provider id, if any. */
export function openRowFor(
  history: readonly HistoryRow[],
  planId: string,
  cycle: BillingCycle,
  providerPlanId: string
): HistoryRow | null {
  return (
    history
      .filter(
        (row) =>
          row.plan_id === planId &&
          row.cycle === cycle &&
          !row.replaced_at &&
          row.provider_plan_id === providerPlanId
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null
  );
}

export function cycleSync(
  plan: PlanRow,
  cycle: BillingCycle,
  history: readonly HistoryRow[]
): CycleSync {
  const providerPlanId = providerIdOf(plan, cycle);
  if (!providerPlanId) {
    return { state: 'unpublished', providerPlanId: null, syncedPrice: null };
  }
  const row = openRowFor(history, plan.id, cycle, providerPlanId);
  if (!row) return { state: 'unknown', providerPlanId, syncedPrice: null };
  const syncedPrice = money(row.price_usd);
  return {
    state:
      publishablePrice(plan, cycle) === syncedPrice
        ? 'synced'
        : 'price_mismatch',
    providerPlanId,
    syncedPrice,
  };
}

export function toPlatformPlan(
  plan: PlanRow,
  history: readonly HistoryRow[]
): PlatformPlan {
  const own = history
    .filter((row) => row.plan_id === plan.id)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description ?? null,
    priceMonth: Number(plan.price_usd_month),
    priceYear:
      plan.price_usd_year === null || plan.price_usd_year === undefined
        ? null
        : Number(plan.price_usd_year),
    limits: plan.limits ?? {},
    features: plan.features ?? [],
    isPublic: plan.is_public,
    sortOrder: plan.sort_order,
    createdAt: plan.created_at ?? null,
    updatedAt: plan.updated_at ?? null,
    sync: {
      month: cycleSync(plan, 'month', own),
      year: cycleSync(plan, 'year', own),
    },
    history: own.map((row) => ({
      id: row.id,
      cycle: row.cycle,
      providerPlanId: row.provider_plan_id,
      priceUsd: money(row.price_usd),
      providerEnv: row.provider_env,
      createdAt: row.created_at,
      replacedAt: row.replaced_at,
    })),
  };
}

// ------------------------------------------------------------
// Data access
// ------------------------------------------------------------

/** Every plan, public or not, with its sync state and history. */
export async function loadPlatformPlans(): Promise<PlatformPlan[]> {
  const db = supabaseAdmin();
  const { data: plans, error } = await db
    .from('plans')
    .select(PLAN_COLUMNS)
    .order('sort_order', { ascending: true });
  if (error) throw error;

  const { data: history, error: historyError } = await db
    .from('plan_provider_history')
    .select(HISTORY_COLUMNS)
    .order('created_at', { ascending: false });
  if (historyError) throw historyError;

  const rows = (history as HistoryRow[] | null) ?? [];
  return ((plans as PlanRow[] | null) ?? []).map((plan) =>
    toPlatformPlan(plan, rows)
  );
}

/** One plan with its sync state, or null. */
export async function loadPlatformPlan(
  planId: string
): Promise<PlatformPlan | null> {
  const db = supabaseAdmin();
  const { data: plan, error } = await db
    .from('plans')
    .select(PLAN_COLUMNS)
    .eq('id', planId)
    .maybeSingle();
  if (error) throw error;
  if (!plan) return null;
  const history = await loadHistory(planId);
  return toPlatformPlan(plan as PlanRow, history);
}

async function loadHistory(
  planId: string,
  cycle?: BillingCycle
): Promise<HistoryRow[]> {
  let query = supabaseAdmin()
    .from('plan_provider_history')
    .select(HISTORY_COLUMNS)
    .eq('plan_id', planId);
  if (cycle) query = query.eq('cycle', cycle);
  const { data, error } = await query.order('created_at', {
    ascending: false,
  });
  if (error) throw error;
  return (data as HistoryRow[] | null) ?? [];
}

// ------------------------------------------------------------
// Sync
// ------------------------------------------------------------

export type PlanSyncErrorCode =
  | 'not_found'
  | 'no_price'
  | 'paypal_not_configured'
  | 'paypal_unknown_plan'
  | 'paypal_unreadable'
  | 'paypal_failed';

export class PlanSyncError extends Error {
  readonly status: number;
  readonly code: PlanSyncErrorCode;
  constructor(status: number, code: PlanSyncErrorCode, message: string) {
    super(message);
    this.name = 'PlanSyncError';
    this.status = status;
    this.code = code;
  }
}

export interface PlanSyncResult {
  synced: true;
  action: 'noop' | 'created' | 'replaced';
  providerPlanId: string;
  /** The PayPal id that was superseded, on `replaced`. */
  previousProviderPlanId?: string;
  /** True when an «unknown» id was read back from PayPal and recorded. */
  verified?: boolean;
}

export interface SyncPayPal extends PayPalCatalogueClient {
  getPlan(planId: string): Promise<PayPalPlanPrice>;
}

const DEFAULT_PAYPAL: SyncPayPal = {
  listProducts,
  createProduct,
  createPlan,
  getPlan,
};

export interface SyncPlanCycleArgs {
  planId: string;
  cycle: BillingCycle;
  actorUserId: string;
  paypal?: SyncPayPal;
}

function requirePayPal(): void {
  if (!paypalConfigured()) {
    throw new PlanSyncError(
      503,
      'paypal_not_configured',
      'PayPal is not configured on this server (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)'
    );
  }
}

/** PayPal failures, turned into something the operator can act on. */
function fromPayPal(err: unknown, providerPlanId?: string): never {
  if (err instanceof PlanSyncError) throw err;
  if (err instanceof PayPalError) {
    if (err.status === 0) {
      throw new PlanSyncError(
        503,
        'paypal_not_configured',
        'PayPal is not configured on this server (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)'
      );
    }
    if (err.status === 404 && providerPlanId) {
      throw new PlanSyncError(
        409,
        'paypal_unknown_plan',
        `PayPal (${currentPayPalEnv()}) does not know plan ${providerPlanId}: it may belong to the other PayPal environment`
      );
    }
    console.error('[plan-sync] PayPal error:', err.status, err.body);
    throw new PlanSyncError(
      502,
      'paypal_failed',
      `PayPal rejected the request (${err.status})`
    );
  }
  throw err;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

/**
 * Record a PayPal id in the history and close every other open row of
 * the plan and cycle. A unique violation means a concurrent sync already
 * recorded this very id (same PayPal-Request-Id → same plan): that row
 * is the one to keep.
 */
async function recordCurrent(args: {
  planId: string;
  cycle: BillingCycle;
  providerPlanId: string;
  priceUsd: string;
  env: PayPalEnv;
  actorUserId: string;
}): Promise<void> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('plan_provider_history')
    .insert({
      plan_id: args.planId,
      cycle: args.cycle,
      provider: 'paypal',
      provider_plan_id: args.providerPlanId,
      price_usd: Number(args.priceUsd),
      provider_env: args.env,
      replaced_at: null,
      replaced_by: null,
      created_by: args.actorUserId,
    })
    .select('id')
    .single();

  let currentId: string | null = (data as { id?: string } | null)?.id ?? null;
  if (error) {
    if (!isUniqueViolation(error)) throw error;
    const { data: existing, error: readError } = await db
      .from('plan_provider_history')
      .select('id')
      .eq('plan_id', args.planId)
      .eq('cycle', args.cycle)
      .eq('provider', 'paypal')
      .eq('provider_env', args.env)
      .eq('provider_plan_id', args.providerPlanId)
      .maybeSingle();
    if (readError) throw readError;
    currentId = (existing as { id?: string } | null)?.id ?? null;
    if (currentId) {
      // The id had been superseded once and is current again (set back by
      // hand): reopen its row, or it would stay «unknown» forever.
      const { error: reopenError } = await db
        .from('plan_provider_history')
        .update({ replaced_at: null, replaced_by: null })
        .eq('id', currentId)
        .eq('plan_id', args.planId);
      if (reopenError) throw reopenError;
    }
  }
  if (!currentId) return;

  const { error: closeError } = await db
    .from('plan_provider_history')
    .update({ replaced_at: new Date().toISOString(), replaced_by: currentId })
    .eq('plan_id', args.planId)
    .eq('cycle', args.cycle)
    .is('replaced_at', null)
    .neq('id', currentId);
  if (closeError) throw closeError;
}

/**
 * Publish one cycle of one plan to PayPal, following the three rules of
 * the spec: no id → create; id at another price → create a new plan and
 * swap the id; id at the same price → nothing.
 */
export async function syncPlanCycle({
  planId,
  cycle,
  actorUserId,
  paypal = DEFAULT_PAYPAL,
}: SyncPlanCycleArgs): Promise<PlanSyncResult> {
  const db = supabaseAdmin();
  const env = currentPayPalEnv();

  const { data: planData, error: planError } = await db
    .from('plans')
    .select(PLAN_COLUMNS)
    .eq('id', planId)
    .maybeSingle();
  if (planError) throw planError;
  const plan = planData as PlanRow | null;
  if (!plan) throw new PlanSyncError(404, 'not_found', 'Plan not found');

  // A free (or priceless) cycle is not something we sell through PayPal.
  const price = publishablePrice(plan, cycle);
  if (!price) {
    throw new PlanSyncError(
      400,
      'no_price',
      `The ${cycle === 'year' ? 'yearly' : 'monthly'} price of this plan is empty or 0; a free plan is not published to PayPal`
    );
  }

  const history = await loadHistory(planId, cycle);
  const currentId = providerIdOf(plan, cycle);
  let historyCount = history.length;
  let verified = false;

  if (currentId) {
    const open = openRowFor(history, planId, cycle, currentId);
    let knownPrice: string | null = open ? money(open.price_usd) : null;

    if (!open) {
      // «verificar»: ask PayPal what this id really charges and write it
      // down, so the state is known from now on.
      requirePayPal();
      let remote: PayPalPlanPrice;
      try {
        remote = await paypal.getPlan(currentId);
      } catch (err) {
        fromPayPal(err, currentId);
      }
      if (!remote.priceUsd || (remote.cycle && remote.cycle !== cycle)) {
        throw new PlanSyncError(
          502,
          'paypal_unreadable',
          `Could not read a USD ${cycle === 'year' ? 'yearly' : 'monthly'} price for PayPal plan ${currentId}`
        );
      }
      knownPrice = money(remote.priceUsd);
      await recordCurrent({
        planId,
        cycle,
        providerPlanId: currentId,
        priceUsd: knownPrice,
        env,
        actorUserId,
      });
      historyCount += 1;
      verified = true;
    }

    if (knownPrice === price) {
      return {
        synced: true,
        action: 'noop',
        providerPlanId: currentId,
        ...(verified ? { verified } : {}),
      };
    }
  }

  // Create (no id) or replace (id at another price).
  requirePayPal();
  let newId: string;
  try {
    const { product } = await ensureProduct(paypal, productNameFromEnv());
    const created = await paypal.createPlan({
      productId: product.id,
      name: paypalPlanName(plan.name, cycle),
      description: paypalPlanDescription(plan.name, cycle),
      cycle,
      priceUsd: price,
      // Deterministic for a retry of the same attempt, different for the
      // next price change (the history grows by one row each time). Kept
      // apart from the bootstrap's `…-v1` keys.
      requestId: `wacrm-${env}-${plan.id}-${cycle}-${price.replace('.', '')}-r${historyCount}`,
    });
    newId = created.id;
  } catch (err) {
    fromPayPal(err);
  }

  const column =
    cycle === 'year' ? 'provider_plan_id_year' : 'provider_plan_id_month';
  const { error: updateError } = await db
    .from('plans')
    .update({ [column]: newId })
    .eq('id', planId);
  if (updateError) throw updateError;

  await recordCurrent({
    planId,
    cycle,
    providerPlanId: newId,
    priceUsd: price,
    env,
    actorUserId,
  });

  return currentId
    ? {
        synced: true,
        action: 'replaced',
        providerPlanId: newId,
        previousProviderPlanId: currentId,
        ...(verified ? { verified } : {}),
      }
    : { synced: true, action: 'created', providerPlanId: newId };
}
