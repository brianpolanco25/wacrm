// ============================================================
// Statement at the cut-off of an account whose Meta messages Cabbity
// pays (fase 10, s10.4; table `statements`, migration 078).
//
//   buildStatement(accountId, periodStart, periodEnd, inputs)
//     PURE. `inputs` are the rows the loader below reads: the account's
//     `message_charges` (075), Meta's rate card (076), the price policy
//     (`subscriptions.meta_pricing`) and the payment method (077).
//
// Rules (spec §s10.4 and its checkpoints)
//   - What counts is a DELIVERED message: a `message_charges` row with
//     `delivered_at` inside [periodStart, periodEnd) and a status of
//     `delivered` or `read` (075 stamps `delivered_at` on `read` too when
//     `delivered` never arrived, and a read message was delivered). A
//     broadcast send Meta refused or that never arrived has no
//     `delivered_at` and is never billed.
//   - Delivered messages with a known Meta category fill the package IN
//     DELIVERY ORDER: the first `included_messages` are in the fee
//     whatever their category, every one after is overage at its own
//     category price (`priceFor`: fixed USD wins over the multiplier).
//     So when the package runs out halfway through a broadcast, only the
//     deliveries after that point are overage.
//   - A message counts even when Meta did not charge for it
//     (`billable = false`: the 1.000 free service messages, the 72 h
//     window). `meta_cost_usd` — Cabbity's real cost — comes ONLY from
//     the `billable` ones; the difference is the margin.
//   - A delivered message whose category is not one Meta prices
//     (missing, or a value outside META_CATEGORIES such as
//     `marketing_lite`) is not counted in the package and not billed; it
//     is listed as «sin categoría» with its raw value, for the human.
//   - `payment_method = 'paypal'`: the fee is PayPal's, so
//     `plan_fee_usd = 0` and the total is the overage alone.
//   - Contract with s10.2: a `MetaRateMissingError` makes the whole
//     statement fail. No partial statement, no message skipped for lack
//     of a rate — so a rate loaded retroactively only ever fills a gap
//     and never re-prices a statement already issued. Every categorised
//     delivery is priced, inside the package too: its rate is what the
//     real cost of a billable one is made of.
//
// The loader reads with the service role and filters every query by
// `account_id` by hand (RLS does not apply to it).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { countryFromPhone } from '@/lib/whatsapp/phone-country';
import { addCycle, addDays } from './webhook-events';
import {
  parseMetaPricing,
  priceFor,
  roundUsd,
  type MetaPricing,
} from './meta-pricing';
import {
  isMetaCategory,
  loadRateCard,
  type MetaCategory,
  type RateCard,
} from './meta-rates';
import type { PaymentMethod } from './entitlements';

/** Days between the cut-off and the read-only lock (spec decision 5). */
export const STATEMENT_GRACE_DAYS = 3;

/** Rows per page when reading `message_charges` (PostgREST caps at 1000). */
export const CHARGES_PAGE_SIZE = 1000;

/** The `message_charges` columns the statement reads. */
export interface ChargeRow {
  id?: string;
  account_id?: string;
  wamid?: string | null;
  whatsapp_config_id: string | null;
  recipient_phone: string | null;
  pricing_category: string | null;
  pricing_billable: boolean | null;
  status: string | null;
  delivered_at: string | null;
}

/** A WhatsApp number of the account, to name it on the statement. */
export interface NumberRow {
  id: string;
  display_phone_number: string | null;
  label: string | null;
}

export interface StatementInputs {
  charges: readonly ChargeRow[];
  rateCard: RateCard;
  pricing: MetaPricing;
  paymentMethod: PaymentMethod;
  numbers?: readonly NumberRow[];
}

/** One line of the breakdown: a number, a category, one price. */
export interface StatementLine {
  whatsapp_config_id: string | null;
  /** Display number (or label) at the time of issue; null if unknown. */
  number: string | null;
  category: MetaCategory;
  market: string;
  /** Meta's rate per message. Internal: never shown to the customer. */
  meta_rate_usd: number;
  /** Price per overage message applied to this account. */
  unit_price_usd: number;
  delivered: number;
  /** Of `delivered`, how many Meta charged for. Internal. */
  billable: number;
  /** Of `delivered`, how many fell inside the package. */
  included: number;
  /** Of `delivered`, how many were overage. */
  overage: number;
  /** Real cost at Meta (billable × rate). Internal. */
  meta_cost_usd: number;
  /** What the customer pays for this line (overage × unit price). */
  charge_usd: number;
}

export interface StatementUsage {
  version: 1;
  included_messages: number;
  /** Deliveries that fell inside the package. */
  package_used: number;
  /** Delivered with a known category (what the package counts). */
  messages_total: number;
  overage_messages: number;
  lines: StatementLine[];
  /** Delivered without a category Meta prices: listed, never billed. */
  uncategorized: { total: number; by_category: Record<string, number> };
}

/** What `buildStatement` produces: the columns of a `statements` row. */
export interface BuiltStatement {
  account_id: string;
  period_start: string;
  period_end: string;
  plan_fee_usd: number;
  usage_charge_usd: number;
  meta_cost_usd: number;
  total_usd: number;
  included_messages: number;
  messages_total: number;
  overage_messages: number;
  usage: StatementUsage;
}

/** Key for a category nobody sent: shown as «sin categoría». */
export const NO_CATEGORY = '(none)';

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`Invalid date on a statement: ${String(value)}`);
  }
  return date.toISOString();
}

/**
 * The category as Meta's price list knows it, or null. Meta writes some
 * with a dash (`authentication-international`); 075 stores them as sent.
 */
export function statementCategory(raw: string | null): MetaCategory | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().replace(/-/g, '_');
  return isMetaCategory(normalized) ? normalized : null;
}

/** Delivered inside [start, end): what the statement counts. */
export function isDeliveredIn(
  row: ChargeRow,
  startMs: number,
  endMs: number
): boolean {
  if (!row.delivered_at) return false;
  if (row.status !== 'delivered' && row.status !== 'read') return false;
  const at = Date.parse(row.delivered_at);
  return Number.isFinite(at) && at >= startMs && at < endMs;
}

function round5(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e5) / 1e5;
}

function numberName(row: NumberRow | undefined): string | null {
  if (!row) return null;
  return row.display_phone_number || row.label || null;
}

/**
 * Fee + overage of one period. Pure; throws `MetaRateMissingError`
 * (whole statement, no partial result) when a delivery has no rate.
 */
export function buildStatement(
  accountId: string,
  periodStart: string | Date,
  periodEnd: string | Date,
  inputs: StatementInputs
): BuiltStatement {
  const start = iso(periodStart);
  const end = iso(periodEnd);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!(endMs > startMs)) {
    throw new RangeError(`Statement period ends before it starts: ${start}`);
  }

  const { pricing, rateCard } = inputs;
  const numbers = new Map((inputs.numbers ?? []).map((n) => [n.id, n]));

  const delivered = inputs.charges
    .filter(
      (row) =>
        (row.account_id === undefined || row.account_id === accountId) &&
        isDeliveredIn(row, startMs, endMs)
    )
    .slice()
    .sort((a, b) => {
      const d = Date.parse(a.delivered_at!) - Date.parse(b.delivered_at!);
      if (d !== 0) return d;
      // A stable tie-break: two deliveries in the same millisecond must
      // fall on the same side of the package every time it is computed.
      const ka = a.wamid ?? a.id ?? '';
      const kb = b.wamid ?? b.id ?? '';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  const uncategorized: Record<string, number> = {};
  let uncategorizedTotal = 0;
  const lines = new Map<string, StatementLine>();
  let position = 0;
  let overageRaw = 0;
  let metaCostRaw = 0;

  for (const row of delivered) {
    const category = statementCategory(row.pricing_category);
    if (!category) {
      const key = row.pricing_category?.trim() || NO_CATEGORY;
      uncategorized[key] = (uncategorized[key] ?? 0) + 1;
      uncategorizedTotal += 1;
      continue;
    }

    // Throws MetaRateMissingError: the statement fails entire.
    const rate = rateCard.rateFor(
      countryFromPhone(row.recipient_phone),
      category,
      row.delivered_at!
    );
    const unitPrice = priceFor(pricing, category, rate.usdPerMessage);
    const inPackage = position < pricing.included_messages;
    position += 1;

    const key = [
      row.whatsapp_config_id ?? '',
      category,
      rate.market,
      rate.usdPerMessage,
      unitPrice,
    ].join('|');
    let line = lines.get(key);
    if (!line) {
      line = {
        whatsapp_config_id: row.whatsapp_config_id,
        number: numberName(
          row.whatsapp_config_id
            ? numbers.get(row.whatsapp_config_id)
            : undefined
        ),
        category,
        market: rate.market,
        meta_rate_usd: rate.usdPerMessage,
        unit_price_usd: round5(unitPrice),
        delivered: 0,
        billable: 0,
        included: 0,
        overage: 0,
        meta_cost_usd: 0,
        charge_usd: 0,
      };
      lines.set(key, line);
    }
    line.delivered += 1;
    if (inPackage) {
      line.included += 1;
    } else {
      line.overage += 1;
      line.charge_usd += unitPrice;
      overageRaw += unitPrice;
    }
    if (row.pricing_billable === true) {
      line.billable += 1;
      line.meta_cost_usd += rate.usdPerMessage;
      metaCostRaw += rate.usdPerMessage;
    }
  }

  const sortedLines = [...lines.values()]
    .map((line) => ({
      ...line,
      meta_cost_usd: roundUsd(line.meta_cost_usd),
      charge_usd: roundUsd(line.charge_usd),
    }))
    .sort((a, b) =>
      (a.number ?? '') !== (b.number ?? '')
        ? (a.number ?? '') < (b.number ?? '')
          ? -1
          : 1
        : a.category < b.category
          ? -1
          : a.category > b.category
            ? 1
            : a.unit_price_usd - b.unit_price_usd
    );

  const messagesTotal = position;
  const packageUsed = Math.min(messagesTotal, pricing.included_messages);
  const overageMessages = messagesTotal - packageUsed;
  const usageCharge = roundUsd(overageRaw);
  const fee = inputs.paymentMethod === 'paypal' ? 0 : pricing.fee_usd;

  return {
    account_id: accountId,
    period_start: start,
    period_end: end,
    plan_fee_usd: roundUsd(fee),
    usage_charge_usd: usageCharge,
    meta_cost_usd: roundUsd(metaCostRaw),
    total_usd: roundUsd(fee + usageCharge),
    included_messages: pricing.included_messages,
    messages_total: messagesTotal,
    overage_messages: overageMessages,
    usage: {
      version: 1,
      included_messages: pricing.included_messages,
      package_used: packageUsed,
      messages_total: messagesTotal,
      overage_messages: overageMessages,
      lines: sortedLines,
      uncategorized: { total: uncategorizedTotal, by_category: uncategorized },
    },
  };
}

// ------------------------------------------------------------
// Periods
// ------------------------------------------------------------

/** One month before `iso`, clamping like `addCycle` (31 mar → 28 feb). */
export function subtractMonth(value: string): string {
  const date = new Date(value);
  const day = date.getUTCDate();
  const prev = new Date(date.getTime());
  prev.setUTCDate(1);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const daysInMonth = new Date(
    Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)
  ).getUTCDate();
  prev.setUTCDate(Math.min(day, daysInMonth));
  return prev.toISOString();
}

/**
 * Where the period that ends at `periodEnd` starts: at the cut-off of
 * the previous statement, so two statements never overlap nor leave a
 * gap — but never more than a month back (a PayPal month with no
 * overage issues no statement, and its deliveries were already inside
 * that month's package).
 */
export function statementPeriodStart(
  periodEnd: string,
  previousPeriodEnd: string | null
): string {
  const monthBefore = subtractMonth(periodEnd);
  if (!previousPeriodEnd) return monthBefore;
  const prev = Date.parse(previousPeriodEnd);
  const end = Date.parse(periodEnd);
  if (!Number.isFinite(prev) || prev >= end) return monthBefore;
  return prev > Date.parse(monthBefore)
    ? new Date(prev).toISOString()
    : monthBefore;
}

/** `period_end + 3 days`: from then on the account is read-only. */
export function statementDueAt(periodEnd: string): string {
  return addDays(iso(periodEnd), STATEMENT_GRACE_DAYS);
}

/**
 * The next cut-off once a statement is settled: one month after the
 * period it closed, never after the date of payment — paying late does
 * not move the billing day. Never moves an end already further on (a
 * PayPal renewal may have pushed it).
 */
export function nextPeriodEnd(
  periodEnd: string,
  currentPeriodEnd: string | null
): string {
  const next = addCycle(iso(periodEnd), 'month');
  if (currentPeriodEnd && Date.parse(currentPeriodEnd) > Date.parse(next)) {
    return iso(currentPeriodEnd);
  }
  return next;
}

/** How the account pays: the stored method, else what `provider` says. */
export function effectivePaymentMethod(
  paymentMethod: string | null | undefined,
  provider: string | null | undefined
): PaymentMethod {
  if (paymentMethod === 'paypal' || paymentMethod === 'manual') {
    return paymentMethod;
  }
  return provider === 'paypal' ? 'paypal' : 'manual';
}

// ------------------------------------------------------------
// What the customer sees
// ------------------------------------------------------------

/** A `statements` row as the service role reads it. */
export interface StatementRow {
  id: string;
  account_id: string;
  period_start: string;
  period_end: string;
  plan_fee_usd: number | string;
  usage: unknown;
  meta_cost_usd?: number | string;
  usage_charge_usd: number | string;
  total_usd: number | string;
  included_messages: number;
  messages_total: number;
  overage_messages: number;
  status: string;
  issued_at: string;
  due_at: string;
  paid_at: string | null;
  paid_by?: string | null;
  paid_reference?: string | null;
  paid_note?: string | null;
  claimed_paid_at?: string | null;
  claimed_by?: string | null;
  claim_note?: string | null;
}

/** Columns of a statement the customer is shown (never the internals). */
export const CUSTOMER_STATEMENT_COLUMNS =
  'id, account_id, period_start, period_end, plan_fee_usd, usage, usage_charge_usd, total_usd, included_messages, messages_total, overage_messages, status, issued_at, due_at, paid_at, claimed_paid_at';

export interface CustomerStatementLine {
  number: string | null;
  category: string;
  delivered: number;
  included: number;
  overage: number;
  unitPriceUsd: number;
  chargeUsd: number;
}

export interface CustomerStatement {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  claimedPaidAt: string | null;
  planFeeUsd: number;
  usageChargeUsd: number;
  totalUsd: number;
  includedMessages: number;
  messagesTotal: number;
  overageMessages: number;
  uncategorized: number;
  lines: CustomerStatementLine[];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function usageOf(raw: unknown): Partial<StatementUsage> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Partial<StatementUsage>)
    : {};
}

/**
 * The statement without what is Cabbity's own business: no `billable`,
 * no Meta rate, no real cost, no payment reference or operator note.
 * Built by listing what goes OUT, so a field added to `usage` later
 * stays internal until somebody decides otherwise.
 */
export function customerStatement(row: StatementRow): CustomerStatement {
  const usage = usageOf(row.usage);
  const lines = Array.isArray(usage.lines) ? usage.lines : [];
  return {
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    paidAt: row.paid_at ?? null,
    claimedPaidAt: row.claimed_paid_at ?? null,
    planFeeUsd: num(row.plan_fee_usd),
    usageChargeUsd: num(row.usage_charge_usd),
    totalUsd: num(row.total_usd),
    includedMessages: num(row.included_messages),
    messagesTotal: num(row.messages_total),
    overageMessages: num(row.overage_messages),
    uncategorized: num(usage.uncategorized?.total),
    lines: lines.map((line) => ({
      number: typeof line.number === 'string' ? line.number : null,
      category: String(line.category),
      delivered: num(line.delivered),
      included: num(line.included),
      overage: num(line.overage),
      unitPriceUsd: num(line.unit_price_usd),
      chargeUsd: num(line.charge_usd),
    })),
  };
}

// ------------------------------------------------------------
// Loader
// ------------------------------------------------------------

export class StatementPricingError extends Error {
  constructor(accountId: string, detail: string) {
    super(`Account ${accountId} has no usable Meta price policy: ${detail}`);
    this.name = 'StatementPricingError';
  }
}

/** The account's delivered charges of the period, every page of them. */
export async function loadPeriodCharges(
  client: SupabaseClient,
  accountId: string,
  periodStart: string,
  periodEnd: string
): Promise<ChargeRow[]> {
  const out: ChargeRow[] = [];
  for (let from = 0; ; from += CHARGES_PAGE_SIZE) {
    const { data, error } = await client
      .from('message_charges')
      .select(
        'id, account_id, wamid, whatsapp_config_id, recipient_phone, pricing_category, pricing_billable, status, delivered_at'
      )
      .eq('account_id', accountId)
      .in('status', ['delivered', 'read'])
      .gte('delivered_at', periodStart)
      .lt('delivered_at', periodEnd)
      .order('delivered_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + CHARGES_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as ChargeRow[];
    out.push(...page);
    if (page.length < CHARGES_PAGE_SIZE) return out;
  }
}

/** The account's numbers, to name them on the breakdown. */
export async function loadAccountNumbers(
  client: SupabaseClient,
  accountId: string
): Promise<NumberRow[]> {
  const { data, error } = await client
    .from('whatsapp_config')
    .select('id, display_phone_number, label')
    .eq('account_id', accountId);
  if (error) throw error;
  return (data ?? []) as NumberRow[];
}

/**
 * Load everything `buildStatement` needs and build it. Throws
 * `MetaRateMissingError` (a rate is missing), `StatementPricingError`
 * (the account has no valid `meta_pricing`) or the database error.
 */
export async function computeStatement(
  client: SupabaseClient,
  args: {
    accountId: string;
    periodStart: string;
    periodEnd: string;
    metaPricing: unknown;
    paymentMethod: PaymentMethod;
    rateCard?: RateCard;
  }
): Promise<BuiltStatement> {
  const parsed = parseMetaPricing(args.metaPricing ?? {});
  if (!parsed.ok) throw new StatementPricingError(args.accountId, parsed.error);
  if (!parsed.value) {
    throw new StatementPricingError(args.accountId, 'meta_pricing is empty');
  }
  const [charges, numbers, rateCard] = await Promise.all([
    loadPeriodCharges(client, args.accountId, args.periodStart, args.periodEnd),
    loadAccountNumbers(client, args.accountId),
    args.rateCard ? Promise.resolve(args.rateCard) : loadRateCard(client),
  ]);
  return buildStatement(args.accountId, args.periodStart, args.periodEnd, {
    charges,
    numbers,
    rateCard,
    pricing: parsed.value,
    paymentMethod: args.paymentMethod,
  });
}
