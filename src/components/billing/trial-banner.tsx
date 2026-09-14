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
// Colours come from the theme tokens of `globals.css`
// (`--primary-soft` fill, `--primary-soft-2` border and hover,
// `--primary` for the clock), the same vocabulary as the tinted pills
// in Settings. The words stay on `--foreground`, not on `--primary`:
// over a 12%-accent fill the accent text lands between 2.1:1 (amber in
// light mode) and 3.8:1, under the 4.5:1 that text this small needs,
// while `--foreground` never drops below 10:1 in either mode. The
// accent arrives through the fill and the border instead, which is
// what "matches the theme" has to mean for something that also has to
// be read at a glance. The clock keeps `--primary` — it is decorative,
// the countdown beside it says the same thing in words.
//
// The first cut copied the fixed ambers of the impersonation strip and
// got both halves of that wrong: the accent is a per-account choice
// (five of them, amber among the five), so a hardcoded amber clashed
// with four themes out of five; and the dark half of the pair,
// `dark:text-amber-100`, never applied — this app switches mode with
// `data-mode` on <html>, not with a `.dark` class, so the `dark:`
// variant of `globals.css` has nothing to match and the countdown
// stayed near-black on a dark header. Tokens have no such half: they
// are redefined by the mode block itself.
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
      className="border-primary-soft-2 bg-primary-soft text-foreground hover:bg-primary-soft-2 flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
    >
      <Clock className="text-primary h-3.5 w-3.5 shrink-0" />
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
