// ============================================================
// /platform/plans — plan catalogue and PayPal sync (s9.3 fills it).
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformPlaceholder } from '@/components/platform/platform-placeholder';

export default async function PlatformPlansPage() {
  await guardPlatformPage();
  return <PlatformPlaceholder section="plans" />;
}
