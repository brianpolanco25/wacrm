import { NextResponse } from 'next/server';
import { resolveEffectiveAccountId } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import { createClient } from '@/lib/supabase/server';
import { SIGNED_URL_TTL_SECONDS } from '@/lib/media/signed-url';
import { MEDIA_BUCKETS, parseStorageObjectUrl } from '@/lib/media/storage-url';

/**
 * Characters refused anywhere in the decoded object path. `storage-js`
 * interpolates the path into `/object/sign/<bucket>/<path>` WITHOUT
 * encoding it, and `fetch` then runs the WHATWG URL parser over it — which
 * turns `\` into `/`, strips tabs and newlines, resolves `%2e%2e` as `..`,
 * and cuts the path at `?` or `#`. Any of those lets a path that starts
 * with `account-A/` reach an object of another account (m14.1 review,
 * round 2). Paths the app writes (`buildMediaPath`) never contain them.
 */
function hasUnsafePathChars(path: string): boolean {
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || '\\%?#'.includes(ch)) return true;
  }
  return false;
}

/**
 * True when `path` is an object of `accountId` in the form storage will
 * actually see it: no unsafe characters, first segment exactly
 * `account-<accountId>`, no empty / dot segments, and — re-parsed exactly
 * as the signing request will be — still under that account's folder.
 */
function pathBelongsTo(
  origin: string,
  bucket: string,
  path: string,
  accountId: string
): boolean {
  if (hasUnsafePathChars(path)) return false;
  const segments = path.split('/');
  if (
    segments[0] !== `account-${accountId}` ||
    segments.some((s) => s === '' || s === '.' || s === '..')
  ) {
    return false;
  }

  const prefix = `/storage/v1/object/sign/${bucket}/account-${accountId}/`;
  let probe: URL;
  try {
    probe = new URL(
      `${origin.replace(/\/+$/, '')}/storage/v1/object/sign/${bucket}/${path}`
    );
  } catch {
    return false;
  }
  if (probe.search || probe.hash || !probe.pathname.startsWith(prefix)) {
    return false;
  }
  return probe.pathname
    .slice(prefix.length)
    .split('/')
    .every((s) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(s);
      } catch {
        return false;
      }
      return decoded !== '' && decoded !== '.' && decoded !== '..';
    });
}

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
  if (
    !accountId ||
    !pathBelongsTo(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      ref.bucket,
      ref.path,
      accountId
    )
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
