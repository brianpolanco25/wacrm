// ============================================================
// /platform — the operator's Resumen (s9.1 shell; s9.2 fills it with
// `platform_metrics()`). Until then, the cards say «coming soon».
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformPlaceholder } from '@/components/platform/platform-placeholder';

export default async function PlatformOverviewPage() {
  await guardPlatformPage();
  return (
    <PlatformPlaceholder
      section="overview"
      cards={['accounts', 'mrr', 'signups', 'delinquent']}
    />
  );
}
