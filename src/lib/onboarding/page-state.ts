// ============================================================
// Server-side guard of the onboarding pages (s9.6).
//
// Called by `/onboarding` and `/onboarding/return` (pages, not the
// layout: a layout does not run again on client navigation). Resolves
// the caller and their onboarding state, or redirects:
//
//   no session                 → /login
//   profile without an account → /dashboard (AccountAccessAlert explains)
//   support session            → /dashboard (the operator does not sign
//                                 the customer up; they see them as they are)
//   onboarding done            → /dashboard
// ============================================================

import { cache } from 'react';
import { redirect, unstable_rethrow } from 'next/navigation';

import {
  getCurrentAccount,
  UnauthorizedError,
  type AccountContext,
} from '@/lib/auth/account';

import { loadOnboardingState, type OnboardingState } from './state';

export const requireOnboardingPage = cache(
  async (): Promise<{ ctx: AccountContext; state: OnboardingState }> => {
    let ctx: AccountContext;
    try {
      ctx = await getCurrentAccount();
    } catch (err) {
      unstable_rethrow(err);
      redirect(err instanceof UnauthorizedError ? '/login' : '/dashboard');
    }
    if (ctx.impersonation) redirect('/dashboard');

    const state = await loadOnboardingState(ctx);
    if (state.step === 'done') redirect('/dashboard');
    return { ctx, state };
  }
);
