// ============================================================
// /platform — the operator's Resumen (s9.2): the whole service at a
// glance, from `GET /api/platform/metrics` (migration 069).
//
// SERVER component on purpose: the guard runs before a byte of the page
// renders, and a user with no `platform_admins` row gets a 404. The
// figures themselves load on the client, so the page opens on a loading
// state rather than on numbers that are not there yet.
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformOverview } from '@/components/platform/platform-overview';

export default async function PlatformOverviewPage() {
  await guardPlatformPage();
  return <PlatformOverview />;
}
