// ============================================================
// /platform/operators — who holds a `platform_admins` row, grant and
// revoke (s9.4).
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformOperators } from '@/components/platform/platform-operators';

export default async function PlatformOperatorsPage() {
  await guardPlatformPage();
  return <PlatformOperators />;
}
