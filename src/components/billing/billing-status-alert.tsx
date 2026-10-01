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
//   incomplete the account signed up and never paid (s9.6, no trial).
//              Read-only, and the way out is `/onboarding` (company
//              details, then the plan), not `/billing`. The dashboard
//              gate normally sends these users there before this renders;
//              it shows during a support session, which the gate lets in.
//
//   statement  a managed account with an open statement (s10.4,
//              `statement_due`): from the cut-off to its due date, the
//              amount, the period and the days left; after it, the lock
//              with its own words («solo lectura por estado de cuenta
//              pendiente») and /billing, where the breakdown is. Both
//              offer «Ya pagué», which leaves a note for Cabbity and
//              changes nothing (the amount and the button are for
//              admin+: `totalUsd` comes back null below that).
//
// `active` and `cancelled` (still inside the paid period) render
// nothing: a banner that is always there is a banner nobody reads.
// ============================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CreditCard, ReceiptText, TriangleAlert } from 'lucide-react';

import { useBillingStatus } from '@/hooks/use-billing-status';
import { Button } from '@/components/ui/button';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import {
  claimStatementPaid,
  daysLeft,
  formatDay,
  formatPeriod,
  formatUsd,
} from './statement-claim';

export function BillingStatusAlert() {
  const router = useRouter();
  const t = useTranslations('Billing');
  // One `/api/billing/status` read per account (`useBillingStatus`,
  // cached and shared with any other consumer). A failed read
  // resolves to null and leaves the banner hidden on purpose — the
  // server is the thing that actually blocks writes, and inventing a
  // "your account is suspended" notice out of a network blip would be
  // worse than saying nothing.
  const status = useBillingStatus();

  if (!status) return null;
  const locked = status.readOnly;
  const held = locked && status.manualHold === true;
  if (!held && status.statement) {
    return (
      <StatementDueAlert
        statement={status.statement}
        locked={locked}
        readAt={status.readAt}
      />
    );
  }
  const incomplete = locked && !held && status.status === 'incomplete';
  const warning = !locked && status.status === 'past_due';
  if (!locked && !warning) return null;

  const graceDate = status.graceUntil
    ? new Date(status.graceUntil).toLocaleDateString()
    : null;

  return (
    <Alert variant="destructive" className="mb-4">
      {locked ? <TriangleAlert /> : <CreditCard />}
      <AlertTitle>
        {held
          ? t('heldTitle')
          : incomplete
            ? t('incomplete.title')
            : locked
              ? t('lockedTitle')
              : t('pastDueTitle')}
      </AlertTitle>
      <AlertDescription>
        {held
          ? t('heldBody')
          : incomplete
            ? t('incomplete.body')
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
            onClick={() => router.push(incomplete ? '/onboarding' : '/billing')}
          >
            {incomplete ? t('incomplete.action') : t('fixNow')}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

/**
 * The `statement_due` variant (s10.4). Before the due date a warning
 * with the amount and the days left; after it, the lock in its own
 * words. «Ya pagué» on both, for admin+ (the amount is null below).
 */
export function StatementDueAlert({
  statement,
  locked,
  readAt,
}: {
  statement: {
    id: string;
    periodStart: string;
    periodEnd: string;
    dueAt: string;
    totalUsd: number | null;
  };
  locked: boolean;
  readAt: number;
}) {
  const router = useRouter();
  const t = useTranslations('Billing.statementAlert');
  const locale = useLocale();
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState(false);

  const period = formatPeriod(
    statement.periodStart,
    statement.periodEnd,
    locale
  );
  const date = formatDay(statement.dueAt, locale);
  const days = daysLeft(statement.dueAt, readAt);
  const isAdmin = statement.totalUsd !== null;
  const total = isAdmin ? formatUsd(statement.totalUsd!, locale) : null;

  async function claim() {
    setBusy(true);
    try {
      const outcome = await claimStatementPaid(statement.id);
      if (outcome.kind === 'claimed') {
        setClaimed(true);
        toast.success(t('claimed'));
      } else {
        toast.error(t(`claimErrors.${outcome.reason}`));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Alert
      variant="destructive"
      className="mb-4"
      data-statement-alert={locked ? 'locked' : 'due'}
    >
      {locked ? <TriangleAlert /> : <ReceiptText />}
      <AlertTitle>{locked ? t('lockedTitle') : t('dueTitle')}</AlertTitle>
      <AlertDescription>
        {locked
          ? t('lockedBody', { period })
          : total !== null
            ? t('dueBody', { period, total, date, days })
            : t('dueBodyNoAmount', { period, date, days })}
      </AlertDescription>
      <AlertAction className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => router.push('/billing')}
        >
          {t('view')}
        </Button>
        {isAdmin && !claimed ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={claim}>
            {t('claim')}
          </Button>
        ) : null}
      </AlertAction>
    </Alert>
  );
}
