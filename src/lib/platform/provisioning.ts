// ============================================================
// What the platform panel CREATES (s9.4): companies, manual plans,
// members and operators.
//
// Same rules as `accounts.ts`, read its header first: everything here
// runs with the SERVICE ROLE, and every query that touches one company
// filters by that company's id. The exceptions are the queries that
// RESOLVE a person rather than a company, and they are named:
//
//   - `findProfileByEmail` looks a person up by email. It cannot carry an
//     account filter — "which company is this person in" is the question.
//   - `findAccountOwnedBy` resolves the company Supabase's invite just
//     created, from the user id Supabase returned (never from the body).
//   - the operator list reads `platform_admins`, which has no account.
//
// Each of them has its waiver, with the reason, in the isolation suite.
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';
import type { MetaBilling } from '@/lib/billing/entitlements';
import { parseMetaPricing, type MetaPricing } from '@/lib/billing/meta-pricing';
import { addCycle } from '@/lib/billing/webhook-events';
import { isPlatformAdmin } from '@/lib/auth/platform-admins';
import { recordPlatformAction } from './audit';
export {
  MAX_MEMBER_NAME_LENGTH,
  OPERATOR_MAX_PASSWORD_LENGTH,
  OPERATOR_MIN_PASSWORD_LENGTH,
} from './password-rules';

// ------------------------------------------------------------
// Input
// ------------------------------------------------------------

/** Longest company name the panel accepts. `accounts.name` is text. */
export const MAX_ACCOUNT_NAME_LENGTH = 120;

// Deliberately loose: one `@`, something on each side, a dot in the
// domain. Supabase validates the address again before sending anything.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed, lower-cased email, or null when it is not one. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

// ------------------------------------------------------------
// People
// ------------------------------------------------------------

export interface ProfileMatch {
  userId: string;
  accountId: string | null;
  fullName: string | null;
  email: string | null;
}

/**
 * The profile behind an email, or null. Every auth user has one since
 * migration 017 (`handle_new_user`), and `profiles.email` is what the
 * panel already shows as a member's address. Supabase stores emails
 * lower-cased, and `normalizeEmail` does the same to the input.
 */
export async function findProfileByEmail(
  email: string
): Promise<ProfileMatch | null> {
  const { data, error } = await supabaseAdmin()
    .from('profiles')
    .select('user_id, account_id, full_name, email')
    .eq('email', email)
    .limit(1);

  if (error) {
    console.error('[platform/provisioning] email lookup failed:', error);
    throw error;
  }
  const row = ((data as Record<string, unknown>[]) ?? [])[0];
  if (!row) return null;
  return {
    userId: row.user_id as string,
    accountId: (row.account_id as string | null) ?? null,
    fullName: (row.full_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
  };
}

export type InviteOutcome =
  { ok: true; userId: string } | { ok: false; reason: 'exists' | 'failed' };

/**
 * Ask Supabase to email an invitation. Supabase creates the auth user
 * right away (unconfirmed), which fires `handle_new_user()`:
 *
 *   - without `inviteToken` (a new company's owner) the user has a
 *     profile and a company of their own by the time this returns (017);
 *   - with `inviteToken` (a member of an existing company, i12.1) the
 *     trigger finds that invitation and the user is born INSIDE that
 *     company with its role (090), no company of their own. The
 *     invitation row must exist before this call.
 *
 * Accepting the email only confirms the address.
 */
export async function inviteAuthUser(params: {
  email: string;
  fullName?: string | null;
  redirectTo: string;
  inviteToken?: string | null;
}): Promise<InviteOutcome> {
  const data: { full_name?: string; invite_token?: string } = {};
  if (params.fullName) data.full_name = params.fullName;
  if (params.inviteToken) data.invite_token = params.inviteToken;
  const { data: result, error } =
    await supabaseAdmin().auth.admin.inviteUserByEmail(params.email, {
      ...(Object.keys(data).length > 0 ? { data } : {}),
      redirectTo: params.redirectTo,
    });

  if (error) {
    const code = (error as { code?: string }).code;
    if (
      code === 'email_exists' ||
      code === 'user_already_exists' ||
      /already (been )?registered|already exists/i.test(error.message ?? '')
    ) {
      return { ok: false, reason: 'exists' };
    }
    console.error('[platform/provisioning] invite failed:', error);
    return { ok: false, reason: 'failed' };
  }
  const userId = result?.user?.id;
  if (!userId) return { ok: false, reason: 'failed' };
  return { ok: true, userId };
}

export type CreateMemberOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: 'exists' | 'rejected' | 'failed' };

/**
 * Create a CONFIRMED user with a password, through the Auth admin API:
 * no email, no link (i12.2). With `inviteToken` in the metadata the
 * signup trigger (090) makes the person a member of the company of that
 * invitation, with its role, and accepts it in the same transaction — so
 * the invitation row must exist before this call. If the trigger refuses
 * (no seat left, invitation gone) GoTrue rolls the whole signup back and
 * answers «Database error …»: `rejected`.
 *
 * Never logs `params`: the password is in there.
 */
export async function createConfirmedMember(params: {
  email: string;
  password: string;
  fullName: string;
  inviteToken: string;
}): Promise<CreateMemberOutcome> {
  const { data: result, error } = await supabaseAdmin().auth.admin.createUser({
    email: params.email,
    password: params.password,
    email_confirm: true,
    user_metadata: {
      full_name: params.fullName,
      invite_token: params.inviteToken,
    },
  });

  if (error) {
    const code = (error as { code?: string }).code;
    const message = error.message ?? '';
    if (
      code === 'email_exists' ||
      code === 'user_already_exists' ||
      /already (been )?registered|already exists/i.test(message)
    ) {
      return { ok: false, reason: 'exists' };
    }
    // Only what identifies the error — never the request.
    const status = (error as { status?: number }).status;
    console.error('[platform/provisioning] member create failed:', {
      code,
      status,
      message,
    });
    if (/database error/i.test(message)) {
      return { ok: false, reason: 'rejected' };
    }
    return { ok: false, reason: 'failed' };
  }
  const userId = result?.user?.id;
  if (!userId) return { ok: false, reason: 'failed' };
  return { ok: true, userId };
}

/**
 * The member of THIS company whose password the operator wants to set,
 * or null. The account filter is the point: a user id that belongs to
 * another company (or to nobody) resolves to nothing, so the route
 * cannot be used to reach a person through the wrong company's file.
 */
export async function findMemberForPasswordChange(
  accountId: string,
  userId: string
): Promise<{ userId: string; email: string | null } | null> {
  const { data, error } = await supabaseAdmin()
    .from('profiles')
    .select('user_id, email')
    .eq('account_id', accountId)
    .eq('user_id', userId)
    .limit(1);
  if (error) {
    console.error('[platform/provisioning] member lookup failed:', error);
    throw error;
  }
  const row = ((data as Record<string, unknown>[]) ?? [])[0];
  if (!row) return null;
  return {
    userId: row.user_id as string,
    email: (row.email as string | null) ?? null,
  };
}

export type PasswordChangeOutcome =
  { ok: true } | { ok: false; reason: 'operator' | 'failed' };

/**
 * Set a user's password directly through the Auth admin API: no email,
 * so it works when Supabase's email rate limit is spent. Refuses another
 * operator's account — an operator who can rewrite a peer's password can
 * take over the panel; they reset their own from their profile.
 */
export async function setMemberPassword(params: {
  userId: string;
  password: string;
}): Promise<PasswordChangeOutcome> {
  if (await isPlatformAdmin(params.userId)) {
    return { ok: false, reason: 'operator' };
  }
  const { error } = await supabaseAdmin().auth.admin.updateUserById(
    params.userId,
    { password: params.password }
  );
  if (error) {
    console.error('[platform/provisioning] password change failed:', error);
    return { ok: false, reason: 'failed' };
  }
  return { ok: true };
}

/**
 * The company `handle_new_user()` created for this user. One per owner
 * (`idx_accounts_one_per_owner`, 017).
 */
export async function findAccountOwnedBy(
  userId: string
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('id, name')
    .eq('owner_user_id', userId)
    .maybeSingle();

  if (error) {
    console.error(
      '[platform/provisioning] owner account lookup failed:',
      error
    );
    throw error;
  }
  if (!data) return null;
  return { id: data.id as string, name: (data.name as string) ?? '' };
}

/** Rename one company. `accounts.id` IS the account scope. */
export async function renameAccount(
  accountId: string,
  name: string
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('accounts')
    .update({ name })
    .eq('id', accountId);
  if (error) {
    console.error('[platform/provisioning] rename failed:', error);
    throw error;
  }
}

// ------------------------------------------------------------
// Manual plans
// ------------------------------------------------------------

export interface PlanOption {
  id: string;
  name: string;
  isPublic: boolean;
  /**
   * The plan's default Meta price policy (`plans.meta_pricing`, 077), or
   * null when it has none. A plan with one (`gestionado`) is assigned
   * with a payment method and a price the operator may edit (s10.3).
   */
  metaPricing: MetaPricing | null;
}

/** `plans.meta_pricing` as a policy, or null when empty or malformed. */
export function planPricingOf(raw: unknown): MetaPricing | null {
  const parsed = parseMetaPricing(raw ?? {});
  return parsed.ok ? parsed.value : null;
}

/**
 * Every plan an operator may assign, public or not — the private ones
 * (an unlimited plan for a partner, say) are exactly what a manual
 * assignment is for. `plans` is the global catalogue, not tenant data.
 */
export async function listPlanOptions(): Promise<PlanOption[]> {
  const { data, error } = await supabaseAdmin()
    .from('plans')
    .select('id, name, is_public, sort_order, meta_pricing')
    .order('sort_order', { ascending: true });

  if (error) {
    console.error('[platform/provisioning] plan list failed:', error);
    throw error;
  }
  return ((data as Record<string, unknown>[]) ?? []).map((row) => ({
    id: row.id as string,
    name: (row.name as string) ?? (row.id as string),
    isPublic: Boolean(row.is_public),
    metaPricing: planPricingOf(row.meta_pricing),
  }));
}

/** The columns of `plans` an assignment needs. */
export interface AssignablePlan {
  id: string;
  name: string;
  price_usd_month: number | string | null;
  provider_plan_id_month: string | null;
  meta_pricing: unknown;
}

/** One plan of the catalogue, or null. `plans` is global, not tenant data. */
export async function loadAssignablePlan(
  planId: string
): Promise<AssignablePlan | null> {
  const { data, error } = await supabaseAdmin()
    .from('plans')
    .select('id, name, price_usd_month, provider_plan_id_month, meta_pricing')
    .eq('id', planId)
    .maybeSingle();
  if (error) {
    console.error('[platform/provisioning] plan lookup failed:', error);
    throw error;
  }
  return (data as AssignablePlan | null) ?? null;
}

/** True iff `planId` names a row of the catalogue. */
export async function planExists(planId: string): Promise<boolean> {
  return (await loadAssignablePlan(planId)) !== null;
}

export interface CurrentSubscription {
  plan_id: string | null;
  provider: string | null;
  status: string | null;
  provider_subscription_id: string | null;
  meta_billing?: string | null;
  meta_pricing?: unknown;
  payment_method?: string | null;
  /** The cut-off anchor of a managed account (078, s10.4). */
  statement_period_end?: string | null;
}

/**
 * The statement cut-off (078, s10.4) of an account that is being given
 * managed billing. An account that was ALREADY managed keeps the anchor
 * it has: what it used since its last cut-off is still to be billed, and
 * a fresh `now() + 1 month` would leave that stretch out of every
 * statement (the period of the next one starts at most a month before
 * its cut-off). Only an account that becomes managed now — or one with
 * no anchor — gets a new one, a month from the assignment (decision of
 * the leader, 2026-10-01).
 */
export function managedStatementAnchor(
  previous: Pick<
    CurrentSubscription,
    'meta_billing' | 'statement_period_end'
  > | null,
  now: Date = new Date()
): string {
  if (previous?.meta_billing === 'managed' && previous.statement_period_end) {
    return previous.statement_period_end;
  }
  return addCycle(now.toISOString(), 'month');
}

/**
 * A subscription PayPal is still billing: it has a gateway id and is
 * `active` or `past_due`. Overwriting that row by hand would leave
 * PayPal charging a customer the database no longer knows about — the
 * operator has to cancel it at PayPal first.
 */
export function isLivePayPalSubscription(
  sub: Pick<CurrentSubscription, 'provider_subscription_id' | 'status'> | null
): boolean {
  return Boolean(
    sub?.provider_subscription_id &&
    (sub.status === 'active' || sub.status === 'past_due')
  );
}

export async function loadCurrentSubscription(
  accountId: string
): Promise<CurrentSubscription | null> {
  const { data, error } = await supabaseAdmin()
    .from('subscriptions')
    .select(
      'plan_id, provider, status, provider_subscription_id, meta_billing, meta_pricing, payment_method, statement_period_end'
    )
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[platform/provisioning] subscription read failed:', error);
    throw error;
  }
  return (data as CurrentSubscription | null) ?? null;
}

/**
 * How a plan with a Meta price policy (`gestionado`, s10.3) is given
 * BY HAND: paid by statement (`manual`), with Cabbity paying Meta or not,
 * and the price the operator settled on (already validated).
 */
export interface ManualManagedTerms {
  paymentMethod: 'manual';
  metaBilling: MetaBilling;
  /**
   * The price of the account. Null = the plan's default
   * (`plans.meta_pricing`); ignored for `direct`.
   */
  metaPricing: MetaPricing | null;
}

/**
 * The row a manual plan leaves behind. Everything the gateway owns is
 * reset — no id, no trial, no grace — so no later reader can mistake it
 * for a PayPal subscription. `manual_hold_*` is NOT here: a suspension is
 * a separate axis (058) and giving a plan does not lift it.
 *
 * Without `terms` (any plan with no Meta price policy): no cycle and no
 * period end — a manual plan has no renewal date, and the one of a
 * previous PayPal subscription would show as a stale "renews on" — and
 * the account leaves the managed Meta billing (`direct`, `{}`, no
 * payment method): a price policy only means something with the plan
 * that carries the package.
 *
 * With `terms` (s10.3, `gestionado` paid by hand): monthly, the period
 * ends one month from now — that is the first cut-off of s10.4 — and the
 * terms are stored on the row. An account that `previous`ly was already
 * managed keeps its cut-off anchor (`managedStatementAnchor`), and its
 * period end follows it, as the cut-off moves it on a manual account.
 */
export function manualPlanRow(
  accountId: string,
  planId: string,
  terms?: ManualManagedTerms,
  now: Date = new Date(),
  previous: Pick<
    CurrentSubscription,
    'meta_billing' | 'statement_period_end'
  > | null = null
) {
  const managed = terms?.metaBilling === 'managed';
  const anchor = managed ? managedStatementAnchor(previous, now) : null;
  return {
    account_id: accountId,
    plan_id: planId,
    provider: 'manual',
    status: 'active',
    provider_subscription_id: null,
    cycle: terms ? 'month' : null,
    trial_ends_at: null,
    grace_until: null,
    current_period_end: terms
      ? (anchor ?? addCycle(now.toISOString(), 'month'))
      : null,
    cancel_at_period_end: false,
    payment_method: terms ? 'manual' : null,
    meta_billing: managed ? 'managed' : 'direct',
    meta_pricing: managed && terms?.metaPricing ? terms.metaPricing : {},
    // s10.4 (078): the cut-off anchor of the statement — a month from
    // now, or the one it had if it was already managed. Null when the
    // account leaves managed billing.
    statement_period_end: anchor,
  };
}

export type PlanOverrideOutcome =
  | { ok: true; fromPlan: string | null; fromProvider: string | null }
  | {
      ok: false;
      reason:
        | 'unknown_plan'
        | 'paypal_active'
        | 'audit_failed'
        | 'needs_terms'
        | 'no_pricing';
    };

/**
 * Give one company a plan by hand (`provider = 'manual'`).
 *
 * The audit comes first, as in `[id]/hold`: an unrecorded plan change
 * does not happen at all.
 *
 * A plan that carries a Meta price policy (077) is refused without
 * `terms` (`needs_terms`): given blind, `gestionado` would bill the fee
 * with nobody paying Meta and no price on the account. The panel always
 * sends them; «Nueva empresa» does not, and its plan step then fails
 * soft (`planError`) so the operator finishes it from the file.
 */
export async function overridePlan(params: {
  accountId: string;
  accountName: string | null;
  planId: string;
  actorUserId: string;
  reason: string;
  terms?: ManualManagedTerms;
  now?: Date;
}): Promise<PlanOverrideOutcome> {
  const plan = await loadAssignablePlan(params.planId);
  if (!plan) return { ok: false, reason: 'unknown_plan' };

  const planPricing = planPricingOf(plan.meta_pricing);
  if (planPricing && !params.terms) {
    return { ok: false, reason: 'needs_terms' };
  }
  const terms: ManualManagedTerms | undefined = params.terms
    ? {
        ...params.terms,
        metaPricing: params.terms.metaPricing ?? planPricing,
      }
    : undefined;
  if (terms?.metaBilling === 'managed' && !terms.metaPricing) {
    return { ok: false, reason: 'no_pricing' };
  }

  const current = await loadCurrentSubscription(params.accountId);
  if (isLivePayPalSubscription(current)) {
    return { ok: false, reason: 'paypal_active' };
  }

  const fromPlan = current?.plan_id ?? null;
  const fromProvider = current?.provider ?? null;
  const row = manualPlanRow(
    params.accountId,
    params.planId,
    terms,
    params.now,
    current
  );

  const logged = await recordPlatformAction({
    action: 'plan_override',
    actorUserId: params.actorUserId,
    accountId: params.accountId,
    accountName: params.accountName,
    reason: params.reason,
    details: {
      from_plan: fromPlan,
      to_plan: params.planId,
      from_provider: fromProvider,
      ...(terms
        ? {
            payment_method: row.payment_method,
            meta_billing: row.meta_billing,
            meta_pricing: row.meta_pricing,
            from_meta_billing: current?.meta_billing ?? null,
            current_period_end: row.current_period_end,
          }
        : {}),
    },
  });
  if (!logged) return { ok: false, reason: 'audit_failed' };

  const { error } = await supabaseAdmin().from('subscriptions').upsert(row, {
    onConflict: 'account_id',
  });
  if (error) {
    console.error('[platform/provisioning] manual plan write failed:', error);
    throw error;
  }

  return { ok: true, fromPlan, fromProvider };
}

// ------------------------------------------------------------
// Members
// ------------------------------------------------------------

/** Members plus outstanding invitations of ONE company — its seats. */
export async function countSeats(accountId: string): Promise<number> {
  const db = supabaseAdmin();
  const [members, pending] = await Promise.all([
    db
      .from('profiles')
      .select('user_id', { count: 'exact', head: true })
      .eq('account_id', accountId),
    db
      .from('account_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()),
  ]);
  if (members.error || pending.error) {
    console.error(
      '[platform/provisioning] seat count failed:',
      members.error ?? pending.error
    );
    throw members.error ?? pending.error;
  }
  return (members.count ?? 0) + (pending.count ?? 0);
}

/**
 * The same `account_invitations` row the Members tab creates
 * (`/api/account/invitations`), written for the company of the file
 * rather than the caller's: it is redeemed by the same `/join/<token>`
 * page and the same `redeem_invitation()` (019/049/052).
 */
export async function insertInvitation(params: {
  accountId: string;
  tokenHash: string;
  role: 'admin' | 'agent' | 'viewer';
  createdBy: string;
  label: string | null;
  expiresAt: Date;
}): Promise<{ id: string; expiresAt: string }> {
  const { data, error } = await supabaseAdmin()
    .from('account_invitations')
    .insert({
      account_id: params.accountId,
      token_hash: params.tokenHash,
      role: params.role,
      created_by_user_id: params.createdBy,
      label: params.label,
      expires_at: params.expiresAt.toISOString(),
    })
    .select('id, expires_at')
    .single();
  if (error || !data) {
    console.error('[platform/provisioning] invitation insert failed:', error);
    throw error ?? new Error('invitation insert returned nothing');
  }
  return {
    id: (data as { id: string }).id,
    expiresAt: (data as { expires_at: string }).expires_at,
  };
}

/**
 * Delete a PENDING invitation of ONE company — the one a route has just
 * written when the signup it was for did not happen, so it stops holding
 * a seat. Filters by account, id and `accepted_at IS NULL`: an accepted
 * invitation is the trail of a member and stays. Never throws: the caller
 * is already answering an error, and an orphan invitation expires anyway.
 */
export async function deleteInvitation(
  accountId: string,
  invitationId: string
): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from('account_invitations')
      .delete()
      .eq('account_id', accountId)
      .eq('id', invitationId)
      .is('accepted_at', null);
    if (error) {
      console.error('[platform/provisioning] invitation delete failed:', error);
    }
  } catch (err) {
    console.error('[platform/provisioning] invitation delete failed:', err);
  }
}

// ------------------------------------------------------------
// Operators
// ------------------------------------------------------------

export interface Operator {
  userId: string;
  email: string | null;
  fullName: string | null;
  grantedAt: string | null;
  grantedBy: string | null;
  note: string | null;
}

/** Everybody in `platform_admins`, with their name and email. */
export async function listOperators(): Promise<Operator[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('platform_admins')
    .select('user_id, granted_by, granted_at, note')
    .order('granted_at', { ascending: true });
  if (error) {
    console.error('[platform/provisioning] operator list failed:', error);
    throw error;
  }
  const rows = (data as Record<string, unknown>[]) ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.user_id as string);
  const { data: people, error: peopleError } = await db
    .from('profiles')
    .select('user_id, full_name, email')
    .in('user_id', ids);
  if (peopleError) {
    console.error(
      '[platform/provisioning] operator names failed:',
      peopleError
    );
    throw peopleError;
  }
  const byId = new Map(
    ((people as Record<string, unknown>[]) ?? []).map((p) => [
      p.user_id as string,
      p,
    ])
  );

  return rows.map((row) => {
    const person = byId.get(row.user_id as string);
    return {
      userId: row.user_id as string,
      email: (person?.email as string | null) ?? null,
      fullName: (person?.full_name as string | null) ?? null,
      grantedAt: (row.granted_at as string | null) ?? null,
      grantedBy: (row.granted_by as string | null) ?? null,
      note: (row.note as string | null) ?? null,
    };
  });
}

export type OperatorChangeOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'self'
        | 'last'
        | 'absent'
        | 'exists'
        | 'user_absent'
        | 'bad_reason'
        | 'failed';
    };

/** Map the codes `platform_*_operator()` raise (migration 071). */
function operatorOutcome(
  error: {
    message?: string;
    code?: string;
  } | null
): OperatorChangeOutcome {
  if (!error) return { ok: true };
  switch (error.message) {
    case 'operator_self':
      return { ok: false, reason: 'self' };
    case 'operator_last':
      return { ok: false, reason: 'last' };
    case 'operator_absent':
      return { ok: false, reason: 'absent' };
    case 'operator_exists':
      return { ok: false, reason: 'exists' };
    case 'user_absent':
      return { ok: false, reason: 'user_absent' };
  }
  // 23514: the reason CHECK of the log (055) refused the row — and with
  // it, in the same transaction, the act.
  if (error.code === '23514') return { ok: false, reason: 'bad_reason' };
  console.error('[platform/provisioning] operator change failed:', error);
  return { ok: false, reason: 'failed' };
}

/**
 * Grant the operator role. The log line and the `platform_admins` row
 * are written by ONE function, in one transaction (migration 071).
 */
export async function grantOperator(params: {
  userId: string;
  actorUserId: string;
  reason: string;
}): Promise<OperatorChangeOutcome> {
  const { error } = await supabaseAdmin().rpc('platform_grant_operator', {
    p_user: params.userId,
    p_by: params.actorUserId,
    p_reason: params.reason,
  });
  return operatorOutcome(error);
}

/**
 * Revoke the operator role — never one's own, never the last one. Both
 * rules are checked inside the function, under a table lock, so two
 * operators revoking each other at once cannot leave the service with
 * nobody to run it.
 */
export async function revokeOperator(params: {
  userId: string;
  actorUserId: string;
  reason: string;
}): Promise<OperatorChangeOutcome> {
  const { error } = await supabaseAdmin().rpc('platform_revoke_operator', {
    p_user: params.userId,
    p_by: params.actorUserId,
    p_reason: params.reason,
  });
  return operatorOutcome(error);
}
