// ============================================================
// /platform/plans — plan catalogue and PayPal sync (s9.3).
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformPlans } from '@/components/platform/platform-plans';

export default async function PlatformPlansPage() {
  await guardPlatformPage();
  return <PlatformPlans />;
}
