'use client';

// /billing/return — where PayPal sends the customer after approving.
//
// This page informs and nothing else: it cannot activate a plan. See
// `src/components/billing/checkout-return.tsx` and §2 of
// docs/saas/fase-3-facturacion.md.
//
// Suspense boundary for the same reason as /billing: the component
// reads the `subscription_id` PayPal appends to the URL.

import { Suspense } from 'react';

import { CheckoutReturn } from '@/components/billing/checkout-return';

export default function BillingReturnPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutReturn />
    </Suspense>
  );
}
