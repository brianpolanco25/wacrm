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
  /**
   * Object path inside the bucket, URL-decoded, no leading slash, and
   * canonical (see `isCanonicalStoragePath`): it names exactly the object
   * a request built from it reaches.
   */
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

  // /storage/v1/object/<route>/<bucket>/<path...> — split without
  // dropping empty segments: `a//b` is not canonical and is refused below.
  const segments = parsed.pathname.split('/').slice(1);
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
  if (!isCanonicalStoragePath(bucket, path)) return null;
  return { bucket, path };
}

/**
 * A character no canonical segment may contain: `\` (fetch turns it into
 * `/`), `%` (a second decode would reveal `%2e%2e` or `%2F`), `?` and `#`
 * (they end the path), and the C0 controls plus DEL (fetch strips tab and
 * newlines, so `.\t.` would become `..`).
 */
const FORBIDDEN_SEGMENT_CHAR = /[\\%?#\u0000-\u001f\u007f]/;

function isCanonicalSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !FORBIDDEN_SEGMENT_CHAR.test(segment)
  );
}

/**
 * True when `bucket` + `path` (already URL-decoded) name exactly one
 * object: the string `@supabase/storage-js` interpolates into the request
 * URL survives WHATWG URL parsing without being rewritten.
 *
 * storage-js builds `<storage-url>/object/<bucket>/<path>` WITHOUT
 * encoding `path`, and `fetch` normalises that URL afterwards. So a path
 * like `account-A/../account-B/x.png` passes a first-segment check and
 * downloads B's object (and `../../..` leaves Storage entirely). Two
 * layers keep that out:
 *
 *  1. every segment is non-empty, not `.`/`..`, and free of `\ % ? #`
 *     and control characters;
 *  2. a round trip through `new URL` gives back the same segments with
 *     an empty query and fragment — the check that does not depend on
 *     the list in (1) being complete.
 *
 * Spaces, accents, dots and capitals inside a name stay valid: fetch only
 * percent-encodes them, and Storage decodes them back to the same name.
 */
export function isCanonicalStoragePath(bucket: string, path: string): boolean {
  if (!isCanonicalSegment(bucket)) return false;
  const pathSegments = path.split('/');
  if (!pathSegments.every(isCanonicalSegment)) return false;

  const prefix = '/storage/v1/object/sign';
  let roundTrip: URL;
  try {
    roundTrip = new URL(`http://storage.invalid${prefix}/${bucket}/${path}`);
  } catch {
    return false;
  }
  if (roundTrip.search !== '' || roundTrip.hash !== '') return false;
  if (!roundTrip.pathname.startsWith(`${prefix}/`)) return false;
  let rebuilt: string[];
  try {
    // `%` is banned above, so every escape here was added by the URL
    // encoder and decoding is its exact inverse.
    rebuilt = roundTrip.pathname
      .slice(prefix.length + 1)
      .split('/')
      .map(decodeURIComponent);
  } catch {
    return false;
  }
  const expected = [bucket, ...pathSegments];
  return (
    rebuilt.length === expected.length &&
    rebuilt.every((segment, i) => segment === expected[i])
  );
}

/**
 * True when `url` is on `origin` (our Supabase project). A server caller
 * that holds the service role uses it to refuse a URL on our own origin
 * that `parseStorageObjectUrl` rejected, instead of passing it on as an
 * external link.
 */
export function isOnOrigin(url: string, origin: string | null | undefined) {
  if (!origin) return false;
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The account a path belongs to, read from its first segment: paths
 * written since migration 020 look like `account-<uuid>/...`. The id
 * must be a whole UUID — `account-<uuid>x` or `account-<prefix>` is not
 * an account folder. Returns null for the pre-020 `<auth.uid()>/...`
 * convention and anything else.
 */
export function accountIdFromPath(path: string): string | null {
  const first = path.split('/')[0] ?? '';
  if (!first.startsWith('account-')) return null;
  const id = first.slice('account-'.length);
  return UUID_RE.test(id) ? id : null;
}

/** Why `assertStoragePathOwnedBy` refused a path. */
export class StoragePathForbiddenError extends Error {
  readonly code = 'forbidden' as const;
  constructor(message = 'storage path does not belong to this account') {
    super(message);
    this.name = 'StoragePathForbiddenError';
  }
}

/**
 * Who a path belongs to, as far as the path alone can say:
 *
 * - `account`: the first segment is exactly `account-<accountId>`;
 * - `legacy`: a pre-020 `<uid>/…` path — the caller must still confirm
 *   that `uid` is a member of the account (a database read).
 *
 * Anything else throws `StoragePathForbiddenError`: a non-canonical path,
 * another account's folder, an account id that is not a strict UUID, a
 * folder that only starts with the account id. Every service-role caller
 * goes through here before touching `storage.from(bucket)`.
 */
export function assertStoragePathOwnedBy(
  ref: StorageObjectRef,
  accountId: string
): { kind: 'account' } | { kind: 'legacy'; uid: string } {
  if (!isCanonicalStoragePath(ref.bucket, ref.path)) {
    throw new StoragePathForbiddenError();
  }
  const owner = accountIdFromPath(ref.path);
  if (owner) {
    if (UUID_RE.test(accountId) && owner === accountId) {
      return { kind: 'account' };
    }
    throw new StoragePathForbiddenError();
  }
  const uid = legacyOwnerFromPath(ref.path);
  if (uid) return { kind: 'legacy', uid };
  throw new StoragePathForbiddenError();
}

/**
 * The uploader's user id for a pre-020 legacy path (`<uuid>/...`), or
 * null when the first segment is not a UUID.
 */
export function legacyOwnerFromPath(path: string): string | null {
  const first = path.split('/')[0] ?? '';
  return UUID_RE.test(first) ? first : null;
}
