import { NextResponse } from 'next/server';
import { resolveEffectiveAccountId } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import { createClient } from '@/lib/supabase/server';
import { SIGNED_URL_TTL_SECONDS } from '@/lib/media/signed-url';
import { MEDIA_BUCKETS, parseStorageObjectUrl } from '@/lib/media/storage-url';

/**
 * GET /api/media/sign?url=<stored media_url>
 *
 * Signs a media-bucket object for the browser when the browser cannot
 * sign it itself: inside a support session (m14.1). There the panel runs
 * with the OPERATOR's JWT, and migration 044's storage policy resolves
 * the account through `profiles.user_id = auth.uid()` — the operator's
 * own company, not the impersonated one — so `createSignedUrl` from the
 * browser is refused and every mirrored attachment renders broken.
 *
 * Here the account is the EFFECTIVE one (`resolveEffectiveAccountId`:
 * the impersonated company in a support session, the caller's own
 * otherwise), and the object's path must sit under `account-<that id>/`
 * before the service role is asked to sign it. That prefix check is the
 * whole tenant boundary of this route, so it is exact: legacy pre-020
 * `<uid>/…` paths, dot segments and other buckets are refused rather
 * than interpreted.
 *
 * GET on purpose: `supportWriteVerdict` only looks at mutating methods,
 * so the support middleware lets it through without recording an action
 * — signing a URL to view an attachment is a read.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = new URL(request.url).searchParams.get('url') ?? '';
  const ref = parseStorageObjectUrl(raw, {
    origin: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
  });
  // Without a configured origin, parseStorageObjectUrl would accept any
  // host shaped like ours: refuse instead.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !ref ||
    !MEDIA_BUCKETS.has(ref.bucket)
  ) {
    return NextResponse.json(
      { error: 'Not a media object of this project' },
      { status: 400 }
    );
  }

  const accountId = await resolveEffectiveAccountId(supabase, user.id);
  const segments = ref.path.split('/');
  if (
    !accountId ||
    segments[0] !== `account-${accountId}` ||
    segments.some((s) => s === '' || s === '.' || s === '..')
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const issuedAt = Date.now();
  const { data, error } = await supabaseAdmin()
    .storage.from(ref.bucket)
    .createSignedUrl(ref.path, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    console.warn('[media/sign] could not sign object:', error?.message);
    return NextResponse.json(
      { error: 'Could not sign the object' },
      { status: 502 }
    );
  }

  return NextResponse.json(
    {
      url: data.signedUrl,
      expiresAt: issuedAt + SIGNED_URL_TTL_SECONDS * 1000,
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
}
