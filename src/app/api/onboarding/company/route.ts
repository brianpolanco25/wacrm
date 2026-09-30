// ============================================================
// POST /api/onboarding/company — step 1 of the paid onboarding (s9.6).
//
// Saves the company profile of the caller's OWN account: name, country,
// phone, industry and team size (decision 6 of the human). Owner only.
//
// Read-only lock: an account that has not paid is `incomplete` and
// therefore read-only for every write in the app. This route is part of
// the way OUT of that lock — like `/api/billing/*` — so it asks for the
// role with `allowReadOnly` and then re-applies the lock by hand for every
// OTHER cause (suspended, expired, past due past its grace, a manual
// hold): those are settled at `/billing` or by the operator, not by
// editing the company's phone number.
//
// Writes with the caller's own session client: `accounts_update` (017)
// already allows owner/admin of the account, and keeps a support session
// out (072). The account id comes from the resolved context, never from
// the body. The only service-role write is the onboarding stamp, inside
// `loadOnboardingState`, filtered by that same id.
// ============================================================

import { NextResponse } from 'next/server';

import {
  assertNotSupportSession,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { assertWritable, getEntitlements } from '@/lib/billing/enforce';
import { validateCompanyProfile } from '@/lib/onboarding/profile';
import { loadOnboardingState } from '@/lib/onboarding/state';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('owner', { allowReadOnly: true });
    // A support session is an `admin` and never gets here past the role,
    // but say it where the session is verified, like the billing routes.
    await assertNotSupportSession(ctx);

    const entitlements = await getEntitlements(ctx.accountId);
    if (entitlements.status !== 'incomplete' || entitlements.manualHold) {
      await assertWritable(ctx.accountId, entitlements);
    }

    const limit = checkRateLimit(
      `admin:onboardingCompany:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const parsed = validateCompanyProfile(body);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, field: parsed.field },
        { status: 400 }
      );
    }
    const profile = parsed.value;

    const { data, error } = await ctx.supabase
      .from('accounts')
      .update({
        name: profile.name,
        country: profile.country,
        phone: profile.phone,
        industry: profile.industry,
        team_size: profile.teamSize,
      })
      .eq('id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[POST /api/onboarding/company] update error:', error);
      return NextResponse.json(
        { error: 'Failed to save the company details' },
        { status: 500 }
      );
    }
    if (!data) {
      // RLS matched nothing: the profile says owner, the policy disagrees.
      return NextResponse.json(
        { error: 'Failed to save the company details' },
        { status: 500 }
      );
    }

    // Next step, decided on the server. For an account that already pays
    // (a manual plan, or paid before 073) this also stamps
    // `onboarding_completed_at` and answers `done`.
    const state = await loadOnboardingState(ctx);
    return NextResponse.json({ step: state.step });
  } catch (err) {
    return toErrorResponse(err);
  }
}
