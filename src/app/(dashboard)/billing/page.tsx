'use client';

// /billing — choose a plan (Fase 3 §2, step 1).
//
// `useSearchParams` (the picker reads `?checkout=cancelled`) opts the
// page out of static prerendering unless it sits under a Suspense
// boundary; without one the production build fails with the "missing
// Suspense with CSR bailout" error. Same split as the settings page.

import { Suspense } from 'react';

import { PlanPicker } from '@/components/billing/plan-picker';

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <PlanPicker />
    </Suspense>
  );
}
