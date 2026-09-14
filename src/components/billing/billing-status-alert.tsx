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
//   held       a platform operator suspended the account by hand
//              (fase 4 §2). Same read-only effect, different way out:
//              only the operator can lift it, so no `/billing` button.
//
// `active`, `trialing` and `cancelled` (still inside the paid period)
// render nothing: a banner that is always there is a banner nobody
// reads.
// ============================================================

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CreditCard, TriangleAlert } from 'lucide-react';

import { useBillingStatus } from '@/hooks/use-billing-status';
import { Button } from '@/components/ui/button';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';

export function BillingStatusAlert() {
  const router = useRouter();
  const t = useTranslations('Billing');
  // Shared with the header's trial countdown (p6.2): one
  // `/api/billing/status` read per account serves both. A failed read
  // resolves to null and leaves the banner hidden on purpose — the
  // server is the thing that actually blocks writes, and inventing a
  // "your account is suspended" notice out of a network blip would be
  // worse than saying nothing.
  const status = useBillingStatus();

  if (!status) return null;
  const locked = status.readOnly;
  const held = locked && status.manualHold === true;
  const warning = !locked && status.status === 'past_due';
  if (!locked && !warning) return null;

  const graceDate = status.graceUntil
    ? new Date(status.graceUntil).toLocaleDateString()
    : null;

  return (
    <Alert variant="destructive" className="mb-4">
      {locked ? <TriangleAlert /> : <CreditCard />}
      <AlertTitle>
        {held ? t('heldTitle') : locked ? t('lockedTitle') : t('pastDueTitle')}
      </AlertTitle>
      <AlertDescription>
        {held
          ? t('heldBody')
          : locked
            ? t('lockedBody')
            : graceDate
              ? t('pastDueBodyWithDate', { date: graceDate })
              : t('pastDueBody')}
      </AlertDescription>
      {/* No "fix now" for a manual hold: `/billing` cannot lift one, and
          a button that charges the card without unlocking anything is
          worse than no button. */}
      {held ? null : (
        <AlertAction>
          <Button
            size="sm"
            variant="outline"
            onClick={() => router.push('/billing')}
          >
            {t('fixNow')}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
