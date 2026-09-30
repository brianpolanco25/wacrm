// ============================================================
// /platform/accounts — the census of every company (fase 4 §2).
//
// Lived at `/platform` until s9.1, which gave that URL to the Resumen.
// SERVER component on purpose: the guard runs before a byte of the page
// renders, and a user with no `platform_admins` row gets a 404.
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformAccounts } from '@/components/platform/platform-accounts';

export default async function PlatformAccountsPage() {
  await guardPlatformPage();
  return <PlatformAccounts />;
}
