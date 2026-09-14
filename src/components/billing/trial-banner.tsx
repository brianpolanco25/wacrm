'use client';

// ============================================================
// TrialBanner — how long the free trial has left, in the header
// (p6.2 §2).
//
// It sits in the chrome rather than in the page body for the reason
// every other permanent notice does: a trial runs out while somebody is
// working, not while they are looking at a billing screen, and the last
// day is the one the countdown exists for. Compact and inline in the
// header's right-hand cluster — it shares the row with the theme toggle
// and the account menu — because it is a reminder, not an alarm: the
// full-width strip above the header is reserved for the impersonation
// warning, which is about somebody else's data.
//
// Visible to EVERY member, not just admins. An agent who finds out the
// trial ended by having their messages refused learned it too late, and
// telling them costs nothing: the endpoint behind it exposes status and
// dates, no money figures and no provider ids.
//
// It says nothing unless the subscription is `trialing` — see
// `trialNotice`. Once the account contracts a plan, or once the trial
// expires and the account moves down the dunning ladder of fase 3, this
// disappears and `BillingStatusAlert` takes over.
// ============================================================

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Clock } from 'lucide-react';

import { useBillingStatus } from '@/hooks/use-billing-status';
import { trialNotice } from '@/lib/billing/trial';

export function TrialBanner() {
  const t = useTranslations('Billing');
  const status = useBillingStatus();

  // The clock comes with the status (`readAt`) rather than from a
  // `Date.now()` in render: React 19 forbids impure calls there, and
  // the day count only has to be as fresh as the read it describes.
  // A tab left open for hours keeps the count it was rendered with
  // until the next mount — day granularity, same as the dunning alert
  // beside it.
  const notice = status
    ? trialNotice(status.status, status.trialEndsAt, status.readAt)
    : null;
  if (!notice) return null;

  return (
    <Link
      href="/billing"
      role="status"
      aria-live="polite"
      className="flex min-w-0 items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-500/25 dark:text-amber-100"
    >
      <Clock className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {notice.kind === 'today'
          ? t('trialEndsToday')
          : t('trialEndsIn', { days: notice.days })}
      </span>
      {/* The whole pill is the link; this is the part that says so.
          Dropped on narrow screens, where the header is already full and
          the countdown itself is the thing worth keeping. */}
      <span className="hidden shrink-0 underline underline-offset-2 sm:inline">
        {t('trialChoosePlan')}
      </span>
    </Link>
  );
}
