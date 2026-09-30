// ============================================================
// /platform/[id] — one account's file (fase 4 §2, s9.1).
//
// Guarded by the `(platform)` layout and, again, here (see
// `guardPlatformPage`). The id is only handed to the client component;
// every read of it happens behind `requirePlatformAdmin()` in
// `/api/platform/accounts/[id]`.
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformAccountDetail } from '@/components/platform/platform-account-detail';

export default async function PlatformAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await guardPlatformPage();
  const { id } = await params;
  return <PlatformAccountDetail accountId={id} />;
}
