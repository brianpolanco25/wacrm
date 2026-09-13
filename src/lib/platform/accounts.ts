// ============================================================
// The data behind the platform panel (docs/saas/fase-4-plataforma.md
// §2): the account list, one account's file, and the manual hold.
//
// ISOLATION — read this before adding a query here
// ------------------------------------------------
// Everything in this module runs with the SERVICE ROLE, which bypasses
// RLS. That is unavoidable: the whole job is looking at companies the
// caller does not belong to. So the rule the rest of the repo enforces
// with `.eq('account_id', …)` is enforced here too, with exactly one
// documented exception:
//
//   - `listAccounts` is cross-account BY DEFINITION — it is the census.
//     It goes through `platform_account_list()` (migration 058), which
//     is granted to `service_role` and to nobody else, and the ONLY
//     caller is `/api/platform/accounts`, behind `requirePlatformAdmin()`.
//   - `loadAccountDetail` and `setManualHold` take one account id and
//     filter EVERY query by it. Not "the id is a uuid so it is safe":
//     filtered, every time, including the ones whose table already has
//     a primary key of `account_id`.
//
// `billing_events` is the one table with no `account_id` at all (041):
// it is the gateway's global log. It is reached the same way the
// customer's own subscription area reaches it — by first collecting
// THIS account's PayPal subscription ids from `subscriptions` and
// `checkout_intents` (both scoped, both holding that id under a UNIQUE
// constraint) and filtering the log by them in the database. No ids, no
// query.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';
import { currentPeriodStart } from '@/lib/billing/entitlements';
import { getEntitlements } from '@/lib/billing/enforce';
import {
  buildUsage,
  parseReceipt,
  type UsageLine,
} from '@/lib/billing/subscription-view';
import { loadAccountAudit, type PlatformAuditEntry } from './audit';

const PROVIDER = 'paypal';

/** How many rows one page of the census carries. */
export const DEFAULT_PAGE_SIZE = 50;
/** Hard ceiling, mirrored from `platform_account_list()`. */
export const MAX_PAGE_SIZE = 200;

/** How many gateway events one account's file shows. */
const HISTORY_LIMIT = 40;

// ------------------------------------------------------------
// Listing
// ------------------------------------------------------------

export interface AccountListRow {
  accountId: string;
  name: string;
  createdAt: string;
  memberCount: number;
  planId: string | null;
  subscriptionStatus: string | null;
  /** Non-null while a platform operator holds this account suspended. */
  manualHoldAt: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  /** Last message in any conversation of the account, or null. */
  lastActivityAt: string | null;
  /** `usage_counters` of the current calendar month, verbatim. */
  usage: Record<string, number>;
}

export interface AccountList {
  accounts: AccountListRow[];
  total: number;
  limit: number;
  offset: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function usageOf(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [metric, value] of Object.entries(
    raw as Record<string, unknown>
  )) {
    const n = Number(value);
    if (Number.isFinite(n)) out[metric] = n;
  }
  return out;
}

/**
 * One page of the census: every account, with plan, status, members,
 * consumption of the cycle and last activity.
 *
 * The aggregates come from `platform_account_list()` rather than from a
 * query per row: members, usage and last activity are three GROUP BYs,
 * and doing them from here would be 3N round trips for an N-row page.
 */
export async function listAccounts(params: {
  search?: string | null;
  limit?: number;
  offset?: number;
}): Promise<AccountList> {
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(params.limit ?? DEFAULT_PAGE_SIZE))
  );
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const search = params.search?.trim() || null;

  const { data, error } = await supabaseAdmin().rpc('platform_account_list', {
    p_search: search,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) {
    console.error('[platform/accounts] census failed:', error);
    throw error;
  }

  const rows = (data as Record<string, unknown>[]) ?? [];

  return {
    accounts: rows.map((row) => ({
      accountId: row.account_id as string,
      name: (row.name as string) ?? '',
      createdAt: row.created_at as string,
      memberCount: num(row.member_count),
      planId: (row.plan_id as string | null) ?? null,
      subscriptionStatus: (row.subscription_status as string | null) ?? null,
      manualHoldAt: (row.manual_hold_at as string | null) ?? null,
      trialEndsAt: (row.trial_ends_at as string | null) ?? null,
      currentPeriodEnd: (row.current_period_end as string | null) ?? null,
      graceUntil: (row.grace_until as string | null) ?? null,
      lastActivityAt: (row.last_activity_at as string | null) ?? null,
      usage: usageOf(row.usage),
    })),
    // The window function returns the same total on every row; an empty
    // page legitimately means zero.
    total: rows.length ? num(rows[0].total_count) : 0,
    limit,
    offset,
  };
}

// ------------------------------------------------------------
// One account's file
// ------------------------------------------------------------

export interface AccountMember {
  userId: string;
  fullName: string | null;
  email: string | null;
  role: string | null;
}

export interface AccountNumber {
  id: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  label: string | null;
  wabaId: string | null;
  status: string;
  isDefault: boolean;
  connectedAt: string | null;
  registeredAt: string | null;
  lastRegistrationError: string | null;
}

export interface BillingHistoryEntry {
  id: string;
  eventType: string;
  receivedAt: string | null;
  processedAt: string | null;
  error: string | null;
  /** Present on `PAYMENT.SALE.COMPLETED`. PayPal's own decimal string. */
  amount: string | null;
  currency: string | null;
}

export interface AccountDetail {
  accountId: string;
  name: string;
  createdAt: string;
  planId: string;
  planName: string | null;
  subscriptionStatus: string;
  readOnly: boolean;
  manualHold: boolean;
  manualHoldAt: string | null;
  manualHoldReason: string | null;
  manualHoldBy: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  cycle: string | null;
  providerSubscriptionId: string | null;
  /** Consumption of the current cycle against the plan's caps. */
  usage: UsageLine[];
  /** Caps that are a headcount of rows, not a counter. */
  limits: Record<string, number | null>;
  members: AccountMember[];
  numbers: AccountNumber[];
  lastActivityAt: string | null;
  billingHistory: BillingHistoryEntry[];
  audit: PlatformAuditEntry[];
}

interface SubscriptionRow {
  plan_id: string | null;
  status: string | null;
  provider_subscription_id: string | null;
  current_period_end: string | null;
  grace_until: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean | null;
  cycle: string | null;
  manual_hold_at: string | null;
  manual_hold_by: string | null;
  manual_hold_reason: string | null;
}

/** Name + creation date, or null when there is no such account. */
export async function loadAccountSummary(
  accountId: string
): Promise<{ id: string; name: string; createdAt: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('id, name, created_at')
    // On `accounts`, the primary key IS the account scope.
    .eq('id', accountId)
    .maybeSingle();

  if (error) {
    console.error('[platform/accounts] account lookup failed:', error);
    throw error;
  }
  if (!data) return null;
  return {
    id: data.id as string,
    name: (data.name as string) ?? '',
    createdAt: data.created_at as string,
  };
}

async function loadSubscription(
  accountId: string
): Promise<SubscriptionRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('subscriptions')
    .select(
      'plan_id, status, provider_subscription_id, current_period_end, ' +
        'grace_until, trial_ends_at, cancel_at_period_end, cycle, ' +
        'manual_hold_at, manual_hold_by, manual_hold_reason'
    )
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    console.error('[platform/accounts] subscription read failed:', error);
    throw error;
  }
  return (data as SubscriptionRow | null) ?? null;
}

async function loadMembers(accountId: string): Promise<AccountMember[]> {
  const { data, error } = await supabaseAdmin()
    .from('profiles')
    .select('user_id, full_name, email, account_role')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[platform/accounts] members read failed:', error);
    throw error;
  }
  return ((data as Record<string, unknown>[]) ?? []).map((row) => ({
    userId: row.user_id as string,
    fullName: (row.full_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    role: (row.account_role as string | null) ?? null,
  }));
}

/**
 * Every WhatsApp number of the account (f4.2 made the relation
 * one-to-many).
 *
 * The access token is NOT selected. An operator does not need it to
 * diagnose a connection, and a panel that prints customer credentials is
 * a credential leak with a nice layout.
 */
async function loadNumbers(accountId: string): Promise<AccountNumber[]> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select(
      'id, phone_number_id, display_phone_number, verified_name, label, ' +
        'waba_id, status, is_default, connected_at, registered_at, ' +
        'last_registration_error'
    )
    .eq('account_id', accountId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[platform/accounts] numbers read failed:', error);
    throw error;
  }
  return ((data as unknown as Record<string, unknown>[]) ?? []).map((row) => ({
    id: row.id as string,
    phoneNumberId: (row.phone_number_id as string) ?? '',
    displayPhoneNumber: (row.display_phone_number as string | null) ?? null,
    verifiedName: (row.verified_name as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    wabaId: (row.waba_id as string | null) ?? null,
    status: (row.status as string) ?? 'disconnected',
    isDefault: Boolean(row.is_default),
    connectedAt: (row.connected_at as string | null) ?? null,
    registeredAt: (row.registered_at as string | null) ?? null,
    lastRegistrationError:
      (row.last_registration_error as string | null) ?? null,
  }));
}

async function loadUsageCounters(accountId: string) {
  const { data, error } = await supabaseAdmin()
    .from('usage_counters')
    .select('metric, value')
    .eq('account_id', accountId)
    .eq('period_start', currentPeriodStart());

  if (error) {
    console.error('[platform/accounts] usage read failed:', error);
    throw error;
  }
  return (data as { metric: string; value: number | string }[]) ?? [];
}

async function loadLastActivity(accountId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('last_message_at')
    .eq('account_id', accountId)
    .not('last_message_at', 'is', null)
    .order('last_message_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[platform/accounts] activity read failed:', error);
    throw error;
  }
  const rows = (data as { last_message_at: string | null }[]) ?? [];
  return rows[0]?.last_message_at ?? null;
}

/** Every PayPal subscription id this account has ever owned. */
async function ownedSubscriptionIds(
  accountId: string,
  subscription: SubscriptionRow | null
): Promise<string[]> {
  const ids = new Set<string>();
  if (subscription?.provider_subscription_id) {
    ids.add(subscription.provider_subscription_id);
  }

  const { data, error } = await supabaseAdmin()
    .from('checkout_intents')
    .select('provider_subscription_id')
    .eq('account_id', accountId)
    .eq('provider', PROVIDER);

  if (error) {
    console.error('[platform/accounts] checkout history read failed:', error);
    throw error;
  }
  for (const row of (data as { provider_subscription_id?: unknown }[]) ?? []) {
    if (
      typeof row?.provider_subscription_id === 'string' &&
      row.provider_subscription_id
    ) {
      ids.add(row.provider_subscription_id);
    }
  }
  return [...ids];
}

function historyEntry(row: Record<string, unknown>): BillingHistoryEntry {
  const receipt = parseReceipt({
    id: row.id as string,
    payload: row.payload,
    received_at: (row.received_at as string | null) ?? null,
  });
  return {
    id: row.id as string,
    eventType: (row.event_type as string) ?? '',
    receivedAt: (row.received_at as string | null) ?? null,
    processedAt: (row.processed_at as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    amount: receipt?.amount ?? null,
    currency: receipt?.currency ?? null,
  };
}

/**
 * The account's gateway history: payments AND the subscription events
 * that moved its status.
 *
 * Two queries rather than one `or()`, because the tenant filter lives in
 * a different JSON path for each: sales carry the subscription id in
 * `resource.billing_agreement_id` (indexed by migration 056) and
 * subscription events in `resource.id` (indexed by 058). One `or()` over
 * both expressions would not use either index.
 *
 * Payloads are NOT returned. They contain the customer's PayPal payer
 * details, and the panel exists to answer "what happened to this
 * account", not to mirror the gateway.
 */
async function loadBillingHistory(
  subscriptionIds: string[]
): Promise<BillingHistoryEntry[]> {
  if (subscriptionIds.length === 0) return [];
  const db = supabaseAdmin();
  const columns = 'id, event_type, payload, received_at, processed_at, error';

  const [sales, events] = await Promise.all([
    db
      .from('billing_events')
      .select(columns)
      .eq('provider', PROVIDER)
      .eq('event_type', 'PAYMENT.SALE.COMPLETED')
      .in('payload->resource->>billing_agreement_id', subscriptionIds)
      .order('received_at', { ascending: false })
      .limit(HISTORY_LIMIT),
    db
      .from('billing_events')
      .select(columns)
      .eq('provider', PROVIDER)
      .like('event_type', 'BILLING.SUBSCRIPTION.%')
      .in('payload->resource->>id', subscriptionIds)
      .order('received_at', { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);

  if (sales.error || events.error) {
    console.error(
      '[platform/accounts] billing history read failed:',
      sales.error ?? events.error
    );
    throw sales.error ?? events.error;
  }

  const rows = [
    ...((sales.data as Record<string, unknown>[]) ?? []),
    ...((events.data as Record<string, unknown>[]) ?? []),
  ];

  return rows
    .map(historyEntry)
    .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
    .slice(0, HISTORY_LIMIT);
}

/**
 * One account's file. `null` when there is no such account — an id that
 * does not exist and an id the operator may not see are the same 404,
 * because for a platform admin there is no second case.
 */
export async function loadAccountDetail(
  accountId: string
): Promise<AccountDetail | null> {
  const summary = await loadAccountSummary(accountId);
  if (!summary) return null;

  const subscription = await loadSubscription(accountId);

  // The same resolution the server enforces with, so the panel can never
  // disagree with the 402/403 the customer is getting.
  const entitlements = await getEntitlements(accountId);

  const [counters, members, numbers, lastActivityAt, audit, planName, ids] =
    await Promise.all([
      loadUsageCounters(accountId),
      loadMembers(accountId),
      loadNumbers(accountId),
      loadLastActivity(accountId),
      loadAccountAudit(accountId),
      loadPlanName(entitlements.planId),
      ownedSubscriptionIds(accountId, subscription),
    ]);

  const billingHistory = await loadBillingHistory(ids);

  return {
    accountId: summary.id,
    name: summary.name,
    createdAt: summary.createdAt,
    planId: entitlements.planId,
    planName,
    subscriptionStatus: entitlements.status,
    readOnly: entitlements.readOnly,
    manualHold: entitlements.manualHold,
    manualHoldAt: subscription?.manual_hold_at ?? null,
    manualHoldReason: subscription?.manual_hold_reason ?? null,
    manualHoldBy: subscription?.manual_hold_by ?? null,
    trialEndsAt: entitlements.trialEndsAt,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    graceUntil: subscription?.grace_until ?? null,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    cycle: subscription?.cycle ?? null,
    providerSubscriptionId: subscription?.provider_subscription_id ?? null,
    usage: buildUsage(entitlements.limits, counters),
    limits: entitlements.limits,
    members,
    numbers,
    lastActivityAt,
    billingHistory,
    audit,
  };
}

async function loadPlanName(planId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('plans')
    .select('id, name')
    .eq('id', planId)
    .maybeSingle();
  if (error) {
    console.error('[platform/accounts] plan name read failed:', error);
    return null;
  }
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : null;
}

// ------------------------------------------------------------
// The manual hold
// ------------------------------------------------------------

export class NoSubscriptionRowError extends Error {
  constructor() {
    super('This account has no subscription row to hold');
    this.name = 'NoSubscriptionRowError';
  }
}

/**
 * Put or lift the manual hold, scoped to one account.
 *
 * Only these three columns are written. `status` is deliberately left
 * alone: it belongs to the PayPal webhook, and writing it here would
 * make the next gateway event look like it contradicted us — and would
 * be undone by that event anyway, which is the exact failure the spec
 * asks us to avoid ("la reactivación por webhook NO levanta una
 * suspensión manual").
 *
 * Returns false when there was no row to update. Migration 046 gives
 * every account a subscription row on signup, so this is the "the seed
 * trigger swallowed its exception" case, not a normal one.
 */
export async function setManualHold(params: {
  accountId: string;
  hold: boolean;
  actorUserId: string;
  reason: string;
}): Promise<boolean> {
  const patch = params.hold
    ? {
        manual_hold_at: new Date().toISOString(),
        manual_hold_by: params.actorUserId,
        manual_hold_reason: params.reason,
      }
    : { manual_hold_at: null, manual_hold_by: null, manual_hold_reason: null };

  const { data, error } = await supabaseAdmin()
    .from('subscriptions')
    .update(patch)
    // `account_id` is the primary key of `subscriptions`, and it is
    // still written out: the rule is the filter, not the key.
    .eq('account_id', params.accountId)
    .select('account_id');

  if (error) {
    console.error('[platform/accounts] manual hold write failed:', error);
    throw error;
  }
  return ((data as unknown[]) ?? []).length > 0;
}
