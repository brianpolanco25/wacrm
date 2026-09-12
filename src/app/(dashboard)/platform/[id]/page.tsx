// ============================================================
// /platform/[id] — one account's file (fase 4 §2).
//
// Same server-side guard as the index. The id is only handed to the
// client component; every read of it happens behind
// `requirePlatformAdmin()` in `/api/platform/accounts/[id]`.
// ============================================================

import { notFound } from 'next/navigation';

import { requirePlatformAdmin } from '@/lib/auth/platform';
import { PlatformAccountDetail } from '@/components/platform/platform-account-detail';

export default async function PlatformAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  try {
    await requirePlatformAdmin();
  } catch {
    notFound();
  }
  const { id } = await params;
  return <PlatformAccountDetail accountId={id} />;
}
