import type { Metadata } from 'next';

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { supportBanner } from '@/lib/auth/support-view';
import { PlatformShell } from '@/components/platform/platform-shell';

// ============================================================
// Layout of the operator's panel (s9.1). Its own chrome — not the CRM's
// sidebar — so nobody mistakes "every company of the service" for their
// own inbox.
//
// SERVER component: the guard runs before the shell renders, and a user
// without a `platform_admins` row gets the 404 of `notFound()`. Every
// page under the group repeats the call (see `guardPlatformPage` for
// why), deduplicated per request.
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

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await guardPlatformPage();
  // Kept from the time `/platform` lived under `(dashboard)`: an operator
  // who walks back to the panel mid-support-session still sees whose
  // company they are in, and the exit button.
  const support = await supportBanner();
  return <PlatformShell support={support}>{children}</PlatformShell>;
}
