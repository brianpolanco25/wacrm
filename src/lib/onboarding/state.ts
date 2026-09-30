// ============================================================
// Where an account is in the paid onboarding (s9.6).
//
// The step is derived on the server from two facts the browser cannot
// forge — the `subscriptions` row (no tenant write policy since 041)
// and the company columns of `accounts` (073) — never from a cookie or
// a query string:
//
//   company  the profile is missing a field, and the caller is the owner
//            (the only one `POST /api/onboarding/company` accepts).
//   plan     the profile is complete and the account has not paid:
//            status `incomplete` (the seed of 073).
//   done     the account pays (any status other than `incomplete`:
//            active, past_due, suspended, cancelled, expired — the
//            dunning ladder takes those over) and the profile is
//            complete, or the caller is a member who cannot complete it.
//
// `incomplete` gates EVERY member, not only the owner: the whole account
// is read-only and there is nothing useful behind the gate. A missing
// profile on an account that already pays (a manual plan from the panel,
// s9.4, or a customer who paid before 073) only gates the owner, who is
// the one who can fill it; their team keeps working.
//
// `onboarding_completed_at` is stamped here, the first time the two
// conditions hold together, whoever notices first: the company route
// (profile saved on an account that already pays), the onboarding page,
// or the dashboard gate (the customer paid, closed the tab, and came back
// the next day). Stamping in the PayPal webhook instead was the other
// option; it would miss the manual plans of s9.4 and the profile filled
// after the payment, and it would put one more write on a path whose job
// is to reconcile money. The stamp is a cache of "done": the gate never
// trusts it on its own — `incomplete` wins over it.
//
// Isolation: the service-role client bypasses RLS, so both queries filter
// by the account id of the resolved context by hand (on `accounts` the id
// IS the account scope). Never by anything from the request.
// ============================================================

import type { AccountContext } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import { hasMinRole } from '@/lib/auth/roles';
import { getEntitlements } from '@/lib/billing/enforce';
import type { SubscriptionStatus } from '@/lib/billing/entitlements';

import { isProfileComplete } from './profile';

export type OnboardingStep = 'company' | 'plan' | 'done';

export interface OnboardingProfile {
  name: string;
  country: string | null;
  phone: string | null;
  industry: string | null;
  teamSize: string | null;
}

export interface OnboardingState {
  step: OnboardingStep;
  status: SubscriptionStatus;
  planId: string;
  /** Step 1 is owner-only (`requireRole('owner')`). */
  canEditCompany: boolean;
  /** The checkout is admin+ (`/api/billing/checkout`). */
  canPay: boolean;
  profile: OnboardingProfile;
  profileComplete: boolean;
  completedAt: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  country: string | null;
  phone: string | null;
  industry: string | null;
  team_size: string | null;
  onboarding_completed_at: string | null;
}

const ACCOUNT_COLUMNS =
  'id, name, country, phone, industry, team_size, onboarding_completed_at';

/**
 * Stamp `onboarding_completed_at` once. Conditional on the column still
 * being NULL, so two tabs racing stamp it once and the first date stays.
 * A failure is logged and swallowed: the stamp is a cache, and the gate
 * reaches the same answer from the subscription and the profile.
 */
async function stampCompleted(accountId: string): Promise<string | null> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from('accounts')
    .update({ onboarding_completed_at: now })
    .eq('id', accountId)
    .is('onboarding_completed_at', null);
  if (error) {
    console.error(
      '[onboarding] could not stamp onboarding_completed_at:',
      error
    );
    return null;
  }
  return now;
}

/**
 * Resolve the onboarding step of the caller's account. Throws on a
 * database error; callers decide whether that fails open (the dashboard
 * gate: the server still refuses writes) or shows an error.
 */
export async function loadOnboardingState(
  ctx: Pick<AccountContext, 'accountId' | 'role'>
): Promise<OnboardingState> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select(ACCOUNT_COLUMNS)
    .eq('id', ctx.accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`[onboarding] account ${ctx.accountId} not found`);
  }
  const account = data as AccountRow;

  const entitlements = await getEntitlements(ctx.accountId);
  const paying = entitlements.status !== 'incomplete';
  const profileComplete = isProfileComplete(account);
  const canEditCompany = ctx.role === 'owner';

  let completedAt = account.onboarding_completed_at;
  let step: OnboardingStep;
  if (!paying) {
    step = profileComplete ? 'plan' : 'company';
  } else if (profileComplete) {
    if (!completedAt) completedAt = await stampCompleted(ctx.accountId);
    step = 'done';
  } else {
    step = canEditCompany ? 'company' : 'done';
  }

  return {
    step,
    status: entitlements.status,
    planId: entitlements.planId,
    canEditCompany,
    canPay: hasMinRole(ctx.role, 'admin'),
    profile: {
      name: account.name,
      country: account.country,
      phone: account.phone,
      industry: account.industry,
      teamSize: account.team_size,
    },
    profileComplete,
    completedAt,
  };
}
