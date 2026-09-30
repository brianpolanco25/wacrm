import type { Metadata } from 'next';

import { OnboardingShell } from '@/components/onboarding/onboarding-shell';

// ============================================================
// Layout of the paid onboarding (s9.6): `/onboarding` and
// `/onboarding/return`.
//
// Its own route group, outside `(dashboard)`, on purpose: the dashboard
// layout is where the onboarding gate lives, and a page under it would
// redirect to itself. It also keeps the CRM's sidebar and header away
// from an account that cannot use anything behind them yet.
//
// No auth logic here: each page resolves the account on the server and
// redirects (sign-in, dashboard) before rendering — see Next docs,
// «Layouts and auth checks»: a layout does not re-render on client
// navigation, a page does.
// ============================================================

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <OnboardingShell>{children}</OnboardingShell>;
}
