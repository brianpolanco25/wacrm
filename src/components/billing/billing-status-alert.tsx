'use client';

// ============================================================
// BillingStatusAlert — the persistent notice of Fase 3 §5.
//
// The dunning ladder is enforced on the server (`requireRole` refuses
// anything above `viewer` while the account is read-only). Without a
// banner the tenant sees the same symptom issue #471 described for the
// unlinked-account case: the app looks normal and simply refuses to
// save. This says which rung of the ladder they are on and puts the
// way out — `/billing` — one click away.
//
// Two rungs are shown, and nothing else:
//
//   past_due   a payment failed, service continues until `grace_until`.
//              Warning, not a blocker.
//   read-only  suspended / expired / past_due past its grace. Every
//              member behaves as a `viewer` until it is settled.
//
// `active`, `trialing` and `cancelled` (still inside the paid period)
// render nothing: a banner that is always there is a banner nobody
// reads.
// ============================================================

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CreditCard, TriangleAlert } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';

interface BillingStatus {
  planId: string;
  status: string;
  readOnly: boolean;
  graceUntil: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export function BillingStatusAlert() {
  const { user } = useAuth();
  const router = useRouter();
  const t = useTranslations('Billing');
  const [status, setStatus] = useState<BillingStatus | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    // A failed fetch leaves the banner hidden on purpose: the server is
    // the thing that actually blocks writes, and inventing a "your
    // account is suspended" notice out of a network blip would be
    // worse than saying nothing.
    fetch('/api/billing/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: BillingStatus | null) => {
        if (!cancelled && data) setStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!status) return null;
  const locked = status.readOnly;
  const warning = !locked && status.status === 'past_due';
  if (!locked && !warning) return null;

  const graceDate = status.graceUntil
    ? new Date(status.graceUntil).toLocaleDateString()
    : null;

  return (
    <Alert variant="destructive" className="mb-4">
      {locked ? <TriangleAlert /> : <CreditCard />}
      <AlertTitle>{locked ? t('lockedTitle') : t('pastDueTitle')}</AlertTitle>
      <AlertDescription>
        {locked
          ? t('lockedBody')
          : graceDate
            ? t('pastDueBodyWithDate', { date: graceDate })
            : t('pastDueBody')}
      </AlertDescription>
      <AlertAction>
        <Button
          size="sm"
          variant="outline"
          onClick={() => router.push('/billing')}
        >
          {t('fixNow')}
        </Button>
      </AlertAction>
    </Alert>
  );
}
