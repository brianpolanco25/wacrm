import { Suspense } from 'react';

import { CheckoutReturn } from '@/components/billing/checkout-return';
import { requireOnboardingPage } from '@/lib/onboarding/page-state';

// /onboarding/return — step 3 of the paid onboarding (s9.6): where PayPal
// sends an account that is still signing up (`checkoutUrls`). The same
// waiting screen as /billing/return — it activates nothing and polls until
// the webhook does — and then moves on to the dashboard by itself, whose
// gate stamps the onboarding as done.
//
// Once the account is active, `requireOnboardingPage` redirects straight
// to /dashboard, so reloading this page after the fact is harmless.

export default async function OnboardingReturnPage() {
  await requireOnboardingPage();
  return (
    <Suspense fallback={null}>
      <CheckoutReturn continueHref="/dashboard" continueOnActive />
    </Suspense>
  );
}
