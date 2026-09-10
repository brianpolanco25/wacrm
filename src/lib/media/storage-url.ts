/**
 * Recognise URLs that point into this project's Supabase Storage.
 *
 * Both media buckets (`chat-media`, `flow-media`) store their object
 * reference in the database as the URL `getPublicUrl()` produces:
 *
 *   <supabase-url>/storage/v1/object/public/<bucket>/<path>
 *
 * That shape is kept as the canonical stored form even after the buckets
 * go private (migration 044) — it is stable, it identifies bucket + path,
 * and every consumer can turn it into whatever it needs: the browser
 * asks for a signed URL, the outbound send downloads the bytes with the
 * service role and uploads them to Meta. Keeping one stored form is what
 * lets the same code work with public and private buckets alike.
 *
 * Pure and dependency-free so it can be imported from client components,
 * server code and the Node script alike.
 */

/** Object path segments Supabase serves objects under. */
const OBJECT_ROUTES = new Set(['public', 'sign', 'authenticated']);

export interface StorageObjectRef {
  bucket: string;
  /** Object path inside the bucket, URL-decoded, no leading slash. */
  path: string;
}

/** The buckets whose objects may be sent to WhatsApp or rendered inline. */
export const MEDIA_BUCKETS: ReadonlySet<string> = new Set([
  'chat-media',
  'flow-media',
]);

/**
 * Parse a Storage object URL into `{ bucket, path }`, or null when the
 * URL is anything else (an external link, Meta's CDN, our own media
 * proxy…). `origin`, when given, must match the URL's origin — the
 * server passes `NEXT_PUBLIC_SUPABASE_URL` so a URL shaped like ours but
 * pointing at another host is never treated as one of our objects.
 */
export function parseStorageObjectUrl(
  url: string,
  opts: { origin?: string | null } = {}
): StorageObjectRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  if (opts.origin) {
    let expected: string;
    try {
      expected = new URL(opts.origin).origin;
    } catch {
      return null;
    }
    if (parsed.origin !== expected) return null;
  }

  // /storage/v1/object/<route>/<bucket>/<path...>
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (
    segments.length < 6 ||
    segments[0] !== 'storage' ||
    segments[1] !== 'v1' ||
    segments[2] !== 'object' ||
    !OBJECT_ROUTES.has(segments[3])
  ) {
    return null;
  }

  const bucket = segments[4];
  let path: string;
  try {
    path = segments.slice(5).map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  if (!bucket || !path) return null;
  return { bucket, path };
}

/**
 * True when the URL is one of our media-bucket objects — the case where
 * a consumer must sign or download it rather than fetch it as-is.
 */
export function isMediaBucketUrl(
  url: string,
  opts: { origin?: string | null } = {}
): boolean {
  const ref = parseStorageObjectUrl(url, opts);
  return ref !== null && MEDIA_BUCKETS.has(ref.bucket);
}

/**
 * The account a path belongs to, read from its first segment: paths
 * written since migration 020 look like `account-<uuid>/...`. Returns
 * null for the pre-020 `<auth.uid()>/...` convention and anything else.
 */
export function accountIdFromPath(path: string): string | null {
  const first = path.split('/')[0] ?? '';
  return first.startsWith('account-') && first.length > 'account-'.length
    ? first.slice('account-'.length)
    : null;
}

/**
 * The uploader's user id for a pre-020 legacy path (`<uuid>/...`), or
 * null when the first segment is not a UUID.
 */
export function legacyOwnerFromPath(path: string): string | null {
  const first = path.split('/')[0] ?? '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    first
  )
    ? first
    : null;
}
