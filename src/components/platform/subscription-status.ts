'use client';

// ============================================================
// The subscription status, in words, for the operator's panel.
//
// Shared by the census (`platform-accounts.tsx`) and the account page
// (`platform-account-detail.tsx`) since s9.6 made `incomplete` — signed
// up, never paid — a state an operator has to recognise at a glance
// («Alta incompleta»). Same labels as the dashboard's «by status» card
// (`Platform.metrics.status`); a status this list does not know yet is
// shown verbatim rather than hidden.
// ============================================================

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

export const KNOWN_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'suspended',
  'cancelled',
  'expired',
  'incomplete',
  'none',
] as const;

export type KnownSubscriptionStatus =
  (typeof KNOWN_SUBSCRIPTION_STATUSES)[number];

export function isKnownSubscriptionStatus(
  status: string
): status is KnownSubscriptionStatus {
  return (KNOWN_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/** `(status) => label`; `null`/empty reads as «no subscription». */
export function useSubscriptionStatusLabel(): (
  status: string | null | undefined
) => string {
  const t = useTranslations('Platform.metrics.status');
  return useCallback(
    (status) => {
      const key = status || 'none';
      return isKnownSubscriptionStatus(key) ? t(key) : key;
    },
    [t]
  );
}
