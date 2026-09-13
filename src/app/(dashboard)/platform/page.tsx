// ============================================================
// /platform — the operator's panel (fase 4 §2).
//
// A SERVER component, and that is the point: the guard runs before a
// byte of this page is rendered, so "only platform admins see it" is not
// a `useEffect` that hides a link. A user with no `platform_admins` row
// gets the 404 of `notFound()` — not a 403, because the existence of the
// panel is not something a tenant needs confirmed.
//
// The sidebar's link is a separate, purely cosmetic check
// (`/api/platform/me`): losing it would hide the entrance, never open
// it.
// ============================================================

import { notFound } from 'next/navigation';

import { requirePlatformAdmin } from '@/lib/auth/platform';
import { PlatformAccounts } from '@/components/platform/platform-accounts';

export default async function PlatformPage() {
  try {
    await requirePlatformAdmin();
  } catch {
    notFound();
  }
  return <PlatformAccounts />;
}
