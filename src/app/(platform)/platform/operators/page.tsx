// ============================================================
// /platform/operators — who holds a `platform_admins` row (s9.4 fills it).
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformPlaceholder } from '@/components/platform/platform-placeholder';

export default async function PlatformOperatorsPage() {
  await guardPlatformPage();
  return <PlatformPlaceholder section="operators" />;
}
