// ============================================================
// /platform/rates — Meta's rate card and country → market table (s10.2).
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformRates } from '@/components/platform/platform-rates';

export default async function PlatformRatesPage() {
  await guardPlatformPage();
  return <PlatformRates />;
}
