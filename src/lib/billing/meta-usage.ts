// ============================================================
// Meta consumption, live (fase 10, s10.5).
//
// Three readings of `message_charges` (075) the customer sees before a
// cut-off, never a second count of anything:
//
//   managed  «Consumo del ciclo»: `buildStatement` (s10.4) over the cycle
//            in progress — from the last cut-off to now — reduced to what
//            the customer may see: package used over the included
//            messages, overage by category, and the estimate at the
//            cut-off (fee + overage). Never the `billable` mark, Meta's
//            rate or Cabbity's real cost (same rule as
//            `customerStatement`).
//   direct   the free service quota of Meta per number, straight from
//            `loadServiceUsage` / `serviceCapState` (p11.3), plus what
//            Meta will charge this month: only the `billable` deliveries,
//            at Meta's rate, no multiplier.
//   broadcast  before sending: recipients × the rate of the template's
//            category for the market of the sending number; for managed,
//            how many fit in what is left of the package and how many go
//            to overage at what price.
//
// A missing rate (`MetaRateMissingError`) never breaks any of them: the
// managed block still counts the package (counting needs no rate) and
// says the estimate is pending; the broadcast estimate says the rate is
// not loaded and the send goes on (CP11: all of this is information).
//
// Every loader runs with the service role and filters by `account_id`
// by hand (CP3).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { countryFromPhone } from '@/lib/whatsapp/phone-country';
import { addCycle } from './webhook-events';
import { parseMetaPricing, roundUsd, type MetaPricing } from './meta-pricing';
import {
  loadRateCard,
  MetaRateMissingError,
  type MetaCategory,
  type RateCard,
} from './meta-rates';
import {
  buildStatement,
  CHARGES_PAGE_SIZE,
  effectivePaymentMethod,
  isDeliveredIn,
  loadAccountNumbers,
  loadPeriodCharges,
  statementCategory,
  statementPeriodStart,
  subtractMonth,
  type BuiltStatement,
  type ChargeRow,
} from './statements';
import { SERVICE_FREE_TIER_PER_NUMBER, type ServiceUsage } from './service-cap';
import type { PaymentMethod } from './entitlements';

/** The first warning, as a percentage of the package or the free tier. */
export const USAGE_WARN_PERCENT = 80;

/** `warn` from 80 %, `full` at 100 % (or once Meta already charges). */
export type UsageAlert = 'warn' | 'full' | null;

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function validMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Whole percentage of `used` over `total`, clamped to 0–100. */
export function percentOf(used: number, total: number): number {
  if (!(total > 0)) return used > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.floor((used / total) * 100)));
}

/** 80 % / 100 % of the package of a managed account. */
export function packageAlert(used: number, included: number): UsageAlert {
  if (included <= 0) return used > 0 ? 'full' : null;
  if (used >= included) return 'full';
  if (used * 100 >= included * USAGE_WARN_PERCENT) return 'warn';
  return null;
}

/**
 * 80 % / 100 % of Meta's free service quota of one number. «Full» is
 * exactly p11.3's `exhausted` (1.000 delivered, or Meta already charging
 * one), so the panel and the inbox banner never disagree.
 */
export function freeTierAlert(state: ServiceUsage): UsageAlert {
  if (state.exhausted) return 'full';
  if (state.used * 100 >= SERVICE_FREE_TIER_PER_NUMBER * USAGE_WARN_PERCENT) {
    return 'warn';
  }
  return null;
}

// ------------------------------------------------------------
// The cycle in progress of a managed account
// ------------------------------------------------------------

export interface CyclePeriod {
  /** Where the cycle in progress started (the last cut-off). */
  start: string;
  /** The next cut-off, when the account has an anchor. */
  cutAt: string | null;
  /** The end of what is counted: now. */
  asOf: string;
}

/**
 * The cycle a managed account is consuming now, with the same rules the
 * cron cuts with (s10.4):
 *
 *   - anchor (`statement_period_end`) still ahead → the cycle ends there
 *     and starts at the previous cut-off, never more than a month back
 *     (`statementPeriodStart`, the cron's own rule);
 *   - anchor already passed (the cut happened and the statement is
 *     waiting for payment, or the cron has not run yet) → what is being
 *     consumed now belongs to the next statement, which starts at the
 *     anchor;
 *   - no anchor → from the last statement, or a month back.
 */
export function currentCycle(args: {
  anchor: string | null;
  lastStatementEnd: string | null;
  now: Date;
}): CyclePeriod {
  const nowMs = args.now.getTime();
  const asOf = iso(args.now);
  const anchorMs = validMs(args.anchor);

  if (anchorMs !== null && anchorMs > nowMs) {
    const cutAt = iso(new Date(anchorMs));
    return {
      start: statementPeriodStart(cutAt, args.lastStatementEnd),
      cutAt,
      asOf,
    };
  }
  if (anchorMs !== null) {
    const start = iso(new Date(anchorMs));
    let cutAt = addCycle(start, 'month');
    // A cron that stopped for months: the next cut-off still lies ahead.
    for (let i = 0; i < 120 && Date.parse(cutAt) <= nowMs; i++) {
      cutAt = addCycle(cutAt, 'month');
    }
    return { start, cutAt, asOf };
  }

  const monthBack = subtractMonth(asOf);
  const lastMs = validMs(args.lastStatementEnd);
  const start =
    lastMs !== null && lastMs < nowMs && lastMs > Date.parse(monthBack)
      ? iso(new Date(lastMs))
      : monthBack;
  return { start, cutAt: null, asOf };
}

// ------------------------------------------------------------
// What a managed customer sees
// ------------------------------------------------------------

export interface OverageByCategory {
  category: MetaCategory;
  messages: number;
  /** Price per overage message; null when it varies (two markets). */
  unitPriceUsd: number | null;
  /** Null while a rate is missing. */
  chargeUsd: number | null;
}

export type ManagedUsageState = 'ok' | 'rate_pending' | 'pricing_missing';

export interface ManagedUsage {
  metaBilling: 'managed';
  state: ManagedUsageState;
  periodStart: string;
  cutAt: string | null;
  asOf: string;
  paymentMethod: PaymentMethod;
  includedMessages: number;
  packageUsed: number;
  overageMessages: number;
  percent: number;
  alert: UsageAlert;
  overageByCategory: OverageByCategory[];
  /** Delivered without a category Meta prices: not counted, not billed. */
  uncategorized: number;
  /** The fixed monthly fee of the package. */
  feeUsd: number;
  /** Null while a rate is missing. */
  overageUsd: number | null;
  /** Fee + overage: what the cycle costs (spec §s10.5). */
  estimatedTotalUsd: number | null;
  /** What the statement of the cut-off will ask for (PayPal: overage only). */
  dueAtCutUsd: number | null;
  /** The market and category whose rate is missing, for the notice. */
  missingRate: { market: string; category: string } | null;
}

/** The customer's view of a built statement: no internals. */
export function summarizeManaged(
  built: BuiltStatement,
  args: {
    pricing: MetaPricing;
    paymentMethod: PaymentMethod;
    period: CyclePeriod;
  }
): ManagedUsage {
  const byCategory = new Map<
    MetaCategory,
    { messages: number; charge: number; prices: Set<number> }
  >();
  for (const line of built.usage.lines) {
    if (line.overage <= 0) continue;
    const entry = byCategory.get(line.category) ?? {
      messages: 0,
      charge: 0,
      prices: new Set<number>(),
    };
    entry.messages += line.overage;
    entry.charge += line.charge_usd;
    entry.prices.add(line.unit_price_usd);
    byCategory.set(line.category, entry);
  }
  const overageByCategory = [...byCategory.entries()]
    .map(([category, e]) => ({
      category,
      messages: e.messages,
      unitPriceUsd: e.prices.size === 1 ? [...e.prices][0] : null,
      chargeUsd: roundUsd(e.charge),
    }))
    .sort((a, b) => b.messages - a.messages);

  const fee = args.pricing.fee_usd;
  const overage = built.usage_charge_usd;
  return {
    metaBilling: 'managed',
    state: 'ok',
    periodStart: args.period.start,
    cutAt: args.period.cutAt,
    asOf: args.period.asOf,
    paymentMethod: args.paymentMethod,
    includedMessages: built.included_messages,
    packageUsed: built.usage.package_used,
    overageMessages: built.overage_messages,
    percent: percentOf(built.usage.package_used, built.included_messages),
    alert: packageAlert(built.messages_total, built.included_messages),
    overageByCategory,
    uncategorized: built.usage.uncategorized.total,
    feeUsd: fee,
    overageUsd: overage,
    estimatedTotalUsd: roundUsd(fee + overage),
    dueAtCutUsd: built.total_usd,
    missingRate: null,
  };
}

/**
 * The package without prices, for when a rate is missing: counting which
 * delivery falls inside the package needs only the order of delivery.
 */
export function countPackage(
  charges: readonly ChargeRow[],
  pricing: MetaPricing,
  period: CyclePeriod
): {
  messagesTotal: number;
  packageUsed: number;
  overageMessages: number;
  uncategorized: number;
  overageByCategory: OverageByCategory[];
} {
  const startMs = Date.parse(period.start);
  const endMs = Date.parse(period.asOf) + 1;
  const delivered = charges
    .filter((row) => isDeliveredIn(row, startMs, endMs))
    .slice()
    .sort((a, b) => Date.parse(a.delivered_at!) - Date.parse(b.delivered_at!));
  let position = 0;
  let uncategorized = 0;
  const overage = new Map<MetaCategory, number>();
  for (const row of delivered) {
    const category = statementCategory(row.pricing_category);
    if (!category) {
      uncategorized += 1;
      continue;
    }
    if (position >= pricing.included_messages) {
      overage.set(category, (overage.get(category) ?? 0) + 1);
    }
    position += 1;
  }
  const packageUsed = Math.min(position, pricing.included_messages);
  return {
    messagesTotal: position,
    packageUsed,
    overageMessages: position - packageUsed,
    uncategorized,
    overageByCategory: [...overage.entries()]
      .map(([category, messages]) => ({
        category,
        messages,
        unitPriceUsd: null,
        chargeUsd: null,
      }))
      .sort((a, b) => b.messages - a.messages),
  };
}

/** The managed block when a rate is missing: counts, no amounts. */
export function pendingManaged(
  charges: readonly ChargeRow[],
  args: {
    pricing: MetaPricing;
    paymentMethod: PaymentMethod;
    period: CyclePeriod;
    missing: MetaRateMissingError;
  }
): ManagedUsage {
  const counted = countPackage(charges, args.pricing, args.period);
  return {
    metaBilling: 'managed',
    state: 'rate_pending',
    periodStart: args.period.start,
    cutAt: args.period.cutAt,
    asOf: args.period.asOf,
    paymentMethod: args.paymentMethod,
    includedMessages: args.pricing.included_messages,
    packageUsed: counted.packageUsed,
    overageMessages: counted.overageMessages,
    percent: percentOf(counted.packageUsed, args.pricing.included_messages),
    alert: packageAlert(counted.messagesTotal, args.pricing.included_messages),
    overageByCategory: counted.overageByCategory,
    uncategorized: counted.uncategorized,
    feeUsd: args.pricing.fee_usd,
    overageUsd: null,
    estimatedTotalUsd: null,
    dueAtCutUsd: null,
    missingRate: {
      market: args.missing.market,
      category: args.missing.category,
    },
  };
}

// ------------------------------------------------------------
// What Meta will charge a direct account
// ------------------------------------------------------------

export interface DirectMetaCost {
  totalUsd: number;
  byCategory: Array<{
    category: MetaCategory;
    billable: number;
    costUsd: number;
  }>;
}

/**
 * Only the deliveries Meta marked `billable`, at Meta's rate in force on
 * the day of delivery, without any multiplier. Throws
 * `MetaRateMissingError` rather than price one at 0.
 */
export function directMetaCost(
  charges: readonly ChargeRow[],
  rateCard: RateCard,
  start: string,
  end: string
): DirectMetaCost {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const byCategory = new Map<
    MetaCategory,
    { billable: number; cost: number }
  >();
  let total = 0;
  for (const row of charges) {
    if (row.pricing_billable !== true) continue;
    if (!isDeliveredIn(row, startMs, endMs)) continue;
    const category = statementCategory(row.pricing_category);
    if (!category) continue;
    const rate = rateCard.rateFor(
      countryFromPhone(row.recipient_phone),
      category,
      row.delivered_at!
    );
    const entry = byCategory.get(category) ?? { billable: 0, cost: 0 };
    entry.billable += 1;
    entry.cost += rate.usdPerMessage;
    byCategory.set(category, entry);
    total += rate.usdPerMessage;
  }
  return {
    totalUsd: roundUsd(total),
    byCategory: [...byCategory.entries()]
      .map(([category, e]) => ({
        category,
        billable: e.billable,
        costUsd: roundUsd(e.cost),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}

// ------------------------------------------------------------
// Broadcast estimate
// ------------------------------------------------------------

/** Template categories a broadcast can carry, as Meta prices them. */
export const BROADCAST_CATEGORIES = [
  'marketing',
  'utility',
  'authentication',
] as const;
export type BroadcastCategory = (typeof BROADCAST_CATEGORIES)[number];

/** `Marketing` / `UTILITY` / … → the category; anything else is marketing. */
export function asBroadcastCategory(value: unknown): BroadcastCategory {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (BROADCAST_CATEGORIES as readonly string[]).includes(v)
    ? (v as BroadcastCategory)
    : 'marketing';
}

export interface DirectBroadcastEstimate {
  metaBilling: 'direct';
  recipients: number;
  category: BroadcastCategory;
  market: string | null;
  ratePending: boolean;
  /** Meta's rate per message; null while it is not loaded. */
  unitUsd: number | null;
  totalUsd: number | null;
}

export interface ManagedBroadcastEstimate {
  metaBilling: 'managed';
  recipients: number;
  category: BroadcastCategory;
  market: string | null;
  ratePending: boolean;
  /** Messages left in the package of the cycle in progress. */
  remaining: number;
  inPackage: number;
  overage: number;
  /** Price per overage message for this account; null while unknown. */
  unitPriceUsd: number | null;
  overageUsd: number | null;
}

export type BroadcastEstimate =
  DirectBroadcastEstimate | ManagedBroadcastEstimate;

/** {n} × Meta's rate, for an account that pays Meta itself. */
export function directBroadcastEstimate(args: {
  recipients: number;
  category: BroadcastCategory;
  market: string | null;
  rateUsd: number | null;
}): DirectBroadcastEstimate {
  const pending = args.rateUsd === null;
  return {
    metaBilling: 'direct',
    recipients: args.recipients,
    category: args.category,
    market: args.market,
    ratePending: pending,
    unitUsd: args.rateUsd,
    totalUsd: pending ? null : roundUsd(args.recipients * args.rateUsd!),
  };
}

/**
 * How a broadcast lands on a managed package: the first `remaining` are
 * inside it, the rest are overage at the account's price.
 */
export function managedBroadcastEstimate(args: {
  recipients: number;
  category: BroadcastCategory;
  market: string | null;
  remaining: number;
  unitPriceUsd: number | null;
}): ManagedBroadcastEstimate {
  const remaining = Math.max(0, args.remaining);
  const inPackage = Math.min(args.recipients, remaining);
  const overage = args.recipients - inPackage;
  const pending = args.unitPriceUsd === null;
  return {
    metaBilling: 'managed',
    recipients: args.recipients,
    category: args.category,
    market: args.market,
    ratePending: pending,
    remaining,
    inPackage,
    overage,
    unitPriceUsd: args.unitPriceUsd,
    overageUsd: pending ? null : roundUsd(overage * args.unitPriceUsd!),
  };
}

// ------------------------------------------------------------
// Loaders (service role; every query filtered by the account)
// ------------------------------------------------------------

/** The `subscriptions` columns these readings need. */
export interface MetaUsageSubscription {
  meta_billing: string | null;
  meta_pricing: unknown;
  payment_method: string | null;
  provider: string | null;
  statement_period_end: string | null;
}

export async function loadMetaUsageSubscription(
  client: SupabaseClient,
  accountId: string
): Promise<MetaUsageSubscription | null> {
  const { data, error } = await client
    .from('subscriptions')
    .select(
      'meta_billing, meta_pricing, payment_method, provider, statement_period_end'
    )
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as MetaUsageSubscription | null) ?? null;
}

/** The cut-off of the account's latest statement up to `now`. */
async function loadLastStatementEnd(
  client: SupabaseClient,
  accountId: string,
  now: Date
): Promise<string | null> {
  const { data, error } = await client
    .from('statements')
    .select('period_end')
    .eq('account_id', accountId)
    .lte('period_end', now.toISOString())
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { period_end: string } | null)?.period_end ?? null;
}

/** Everything the managed readings work on, for the cycle in progress. */
export interface ManagedCycle {
  period: CyclePeriod;
  pricing: MetaPricing | null;
  paymentMethod: PaymentMethod;
  charges: ChargeRow[];
  rateCard: RateCard;
  numbers: Awaited<ReturnType<typeof loadAccountNumbers>>;
}

export async function loadManagedCycle(
  client: SupabaseClient,
  accountId: string,
  sub: MetaUsageSubscription,
  now: Date
): Promise<ManagedCycle> {
  const parsed = parseMetaPricing(sub.meta_pricing ?? {});
  const pricing = parsed.ok ? parsed.value : null;
  const paymentMethod = effectivePaymentMethod(
    sub.payment_method,
    sub.provider
  );
  const lastStatementEnd = await loadLastStatementEnd(client, accountId, now);
  const period = currentCycle({
    anchor: sub.statement_period_end,
    lastStatementEnd,
    now,
  });
  // `loadPeriodCharges` reads [start, end): one millisecond past now so
  // a delivery stamped this very instant is counted.
  const end = new Date(now.getTime() + 1).toISOString();
  const [charges, numbers, rateCard] = await Promise.all([
    pricing
      ? loadPeriodCharges(client, accountId, period.start, end)
      : Promise.resolve([] as ChargeRow[]),
    loadAccountNumbers(client, accountId),
    loadRateCard(client),
  ]);
  return { period, pricing, paymentMethod, charges, rateCard, numbers };
}

/** The «Consumo del ciclo» block from a loaded cycle. */
export function managedUsageOf(
  accountId: string,
  cycle: ManagedCycle
): ManagedUsage {
  const { period, pricing, paymentMethod } = cycle;
  if (!pricing) {
    return {
      metaBilling: 'managed',
      state: 'pricing_missing',
      periodStart: period.start,
      cutAt: period.cutAt,
      asOf: period.asOf,
      paymentMethod,
      includedMessages: 0,
      packageUsed: 0,
      overageMessages: 0,
      percent: 0,
      alert: null,
      overageByCategory: [],
      uncategorized: 0,
      feeUsd: 0,
      overageUsd: null,
      estimatedTotalUsd: null,
      dueAtCutUsd: null,
      missingRate: null,
    };
  }
  const end = new Date(Date.parse(period.asOf) + 1).toISOString();
  try {
    const built = buildStatement(accountId, period.start, end, {
      charges: cycle.charges,
      numbers: cycle.numbers,
      rateCard: cycle.rateCard,
      pricing,
      paymentMethod,
    });
    return summarizeManaged(built, { pricing, paymentMethod, period });
  } catch (err) {
    if (err instanceof MetaRateMissingError) {
      return pendingManaged(cycle.charges, {
        pricing,
        paymentMethod,
        period,
        missing: err,
      });
    }
    throw err;
  }
}

/**
 * The account's `billable` deliveries in [start, end), every page —
 * the only rows Meta's cost of a direct account is made of.
 */
export async function loadBillableCharges(
  client: SupabaseClient,
  accountId: string,
  start: string,
  end: string
): Promise<ChargeRow[]> {
  const out: ChargeRow[] = [];
  for (let from = 0; ; from += CHARGES_PAGE_SIZE) {
    const { data, error } = await client
      .from('message_charges')
      .select(
        'id, account_id, wamid, whatsapp_config_id, recipient_phone, pricing_category, pricing_billable, status, delivered_at'
      )
      .eq('account_id', accountId)
      .eq('pricing_billable', true)
      .in('status', ['delivered', 'read'])
      .gte('delivered_at', start)
      .lt('delivered_at', end)
      .order('delivered_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + CHARGES_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as ChargeRow[];
    out.push(...page);
    if (page.length < CHARGES_PAGE_SIZE) return out;
  }
}
