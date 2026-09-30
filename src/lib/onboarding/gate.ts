// ============================================================
// The onboarding gate of the dashboard (s9.6).
//
// Called by the SERVER layout of `src/app/(dashboard)/`, which then does
// `redirect()` with the answer. Why there and not in the middleware:
//
//   * The middleware runs on Edge before every request, including every
//     asset-less API call and prefetch. Deciding the gate there means a
//     database round trip per request (subscriptions + accounts), or a
//     signed cookie that would go stale the moment the PayPal webhook
//     activates the account — exactly the moment the gate must open.
//   * The layout runs once per navigation INTO the dashboard group (Next
//     docs, «Layouts and auth checks»: layouts do not re-render on client
//     navigation between their pages). That is the right cost: an
//     account does not fall back into `incomplete` while someone is
//     inside, and a user coming from `/onboarding` (another group) always
//     renders the layout fresh.
//   * It is not the security boundary, and the docs are right that a
//     layout cannot be one: writes are refused where the data is, by
//     `requireRole` → `assertWritable` (an `incomplete` account is
//     read-only) and by the RLS of `subscriptions`. The gate is the way
//     in, not the lock.
//
// Exempt by construction — they never render this layout: `/onboarding`
// and `/onboarding/return` (their own group), `/platform` (its group),
// `/auth/*`, `/reset-password`, `/join/*`, `/login`, `/signup`, and every
// `/api/*` route (the WhatsApp and PayPal webhooks, `/api/v1`, crons,
// `/api/platform`, `/api/billing`). An incomplete account's checkout
// returns to `/onboarding/return`, not to `/billing/return`, so the one
// page of the dashboard group that a paying-in-progress customer needs
// has its twin outside the gate (`checkoutUrls`).
//
// Exempt by rule, below: a support session (the operator looks at the
// customer as they are), platform operators (sent to `/platform`), and
// members of an account that pays (their `account_id` is the paying one,
// so `loadOnboardingState` answers `done`).
// ============================================================

import { cache } from 'react';
import { unstable_rethrow } from 'next/navigation';

import { getCurrentAccount } from '@/lib/auth/account';
import { isPlatformAdmin } from '@/lib/auth/platform-admins';

import { loadOnboardingState } from './state';

export const ONBOARDING_PATH = '/onboarding';
export const PLATFORM_PATH = '/platform';

/**
 * Where the dashboard must send this request instead, or `null` to let it
 * through. Never throws: an error here would 500 the whole CRM, and the
 * server refuses the writes of an unpaid account anyway. Next's own
 * control-flow signals are re-thrown, as in `support-view.ts`.
 */
export const onboardingRedirect = cache(async (): Promise<string | null> => {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    unstable_rethrow(err);
    // No session (the client shell sends them to /login) or a profile
    // without account (AccountAccessAlert explains it). Not ours.
    return null;
  }

  if (ctx.impersonation) return null;

  try {
    const state = await loadOnboardingState(ctx);
    if (state.step === 'done') return null;
  } catch (err) {
    unstable_rethrow(err);
    console.error(
      '[onboarding gate] could not resolve the onboarding state:',
      err
    );
    return null;
  }

  // Only asked when the gate would close: one lookup for the few who
  // reach this line, none for everyone who already pays.
  if (await isPlatformAdmin(ctx.userId)) return PLATFORM_PATH;
  return ONBOARDING_PATH;
});
