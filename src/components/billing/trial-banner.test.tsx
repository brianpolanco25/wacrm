import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import type { BillingStatus } from '@/hooks/use-billing-status';

// ============================================================
// p6.2 §2. No jsdom in this repo (and no new deps), so the banner is
// rendered to static markup — the same approach as
// impersonation-banner.test.tsx. The shared status hook is mocked so
// each case pins one subscription state; the arithmetic behind the
// wording lives in `lib/billing/trial.test.ts`.
// ============================================================

const status = vi.hoisted(() => ({ value: null as BillingStatus | null }));

vi.mock('@/hooks/use-billing-status', () => ({
  useBillingStatus: () => status.value,
}));

const { TrialBanner } = await import('./trial-banner');

const DAY = 86_400_000;
/** The clock the snapshot was read at. It travels in the status
 *  (`readAt`), so the banner is a pure function of its input and a day
 *  boundary can never depend on how long the test took. */
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function subscription(over: Partial<BillingStatus>): BillingStatus {
  return {
    planId: 'inicio',
    status: 'trialing',
    readOnly: false,
    graceUntil: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    readAt: NOW,
    ...over,
  };
}

function render(
  value: BillingStatus | null,
  locale: 'en' | 'ko' = 'en'
): string {
  status.value = value;
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={locale === 'en' ? en : ko}
    >
      <TrialBanner />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  status.value = null;
});

describe('TrialBanner', () => {
  it('counts the days left and links to /billing while trialing', () => {
    const html = render(
      subscription({
        status: 'trialing',
        trialEndsAt: new Date(NOW + 5 * DAY).toISOString(),
      })
    );
    expect(html).toContain('Trial ends in 5 days');
    expect(html).toContain('href="/billing"');
    expect(html).toContain('Choose a plan');
  });

  it('renders nothing once the account contracted a plan', () => {
    // "Desaparece al contratar": the same mount, one status later.
    expect(render(subscription({ status: 'active' }))).toBe('');
  });

  it('says "today" when the trial ran out but the row still says trialing', () => {
    const html = render(
      subscription({
        status: 'trialing',
        trialEndsAt: new Date(NOW - 2 * DAY).toISOString(),
      })
    );
    expect(html).toContain('Trial ends today');
    expect(html).not.toContain('days');
  });

  it('renders nothing while the status is unknown', () => {
    // A failed read, or the window before it lands. Inventing a
    // deadline out of a network blip is worse than saying nothing.
    expect(render(null)).toBe('');
  });

  it('renders nothing on any rung of the dunning ladder', () => {
    // Those belong to BillingStatusAlert; two notices about the same
    // thing is one too many.
    expect(
      render(
        subscription({
          status: 'past_due',
          trialEndsAt: new Date(NOW - DAY).toISOString(),
        })
      )
    ).toBe('');
  });

  it('announces itself to assistive technology', () => {
    const html = render(
      subscription({
        status: 'trialing',
        trialEndsAt: new Date(NOW + 3 * DAY).toISOString(),
      })
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it('is translated, not English with a Korean shell (CP6)', () => {
    const html = render(
      subscription({
        status: 'trialing',
        trialEndsAt: new Date(NOW + 5 * DAY).toISOString(),
      }),
      'ko'
    );
    expect(html).toContain(ko.Billing.trialChoosePlan);
    expect(html).toContain('5');
    // A missing key renders as the keypath; this is what catches that.
    expect(html).not.toContain('Billing.');
  });

  it('is painted with the theme tokens, not a hardcoded accent', () => {
    // Ronda de estilo: the pill has to follow whichever accent the
    // account picked (five of them) and stay legible in both modes.
    // `dark:` utilities are the trap this pins down — this app switches
    // mode with `data-mode` on <html>, so a `dark:` class never
    // matches and would leave the countdown unreadable on the dark
    // header.
    const html = render(
      subscription({
        status: 'trialing',
        trialEndsAt: new Date(NOW + 5 * DAY).toISOString(),
      })
    );
    expect(html).toContain('bg-primary-soft');
    expect(html).toContain('text-foreground');
    expect(html).not.toContain('amber');
    expect(html).not.toContain('dark:');
  });

  it('uses the ICU singular on the exact one-day boundary (en)', () => {
    const html = render(
      subscription({
        status: 'trialing',
        trialEndsAt: new Date(NOW + DAY).toISOString(),
      })
    );
    expect(html).toContain('Trial ends in 1 day');
    expect(html).not.toContain('1 days');
  });
});
