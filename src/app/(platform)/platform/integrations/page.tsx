// ============================================================
// /platform/integrations — catálogo de integraciones (n13.1).
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformIntegrations } from '@/components/platform/platform-integrations';

export default async function PlatformIntegrationsPage() {
  await guardPlatformPage();
  return <PlatformIntegrations />;
}
