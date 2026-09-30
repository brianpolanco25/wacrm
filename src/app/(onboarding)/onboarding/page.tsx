import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';

import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { requireOnboardingPage } from '@/lib/onboarding/page-state';

// /onboarding — company details, then the plan (s9.6). The step comes
// from the server; see `loadOnboardingState`.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Onboarding');
  return { title: t('title') };
}

export default async function OnboardingPage() {
  const { state } = await requireOnboardingPage();
  // `step` is never 'done' here: requireOnboardingPage redirected.
  const step = state.step === 'company' ? 'company' : 'plan';
  return (
    // Suspense: the plan step's PlanPicker reads `?checkout=cancelled`
    // with useSearchParams (same split as /billing).
    <Suspense fallback={null}>
      <OnboardingFlow
        state={{
          step,
          canEditCompany: state.canEditCompany,
          canPay: state.canPay,
          profile: state.profile,
        }}
      />
    </Suspense>
  );
}
