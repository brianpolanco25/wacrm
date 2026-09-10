import { isMediaBucketUrl, parseStorageObjectUrl } from './storage-url';

/**
 * Short-lived signed URLs for the media buckets, for the browser.
 *
 * `messages.media_url` and a Flow node's `media_url` keep the public-URL
 * shape (`…/storage/v1/object/public/<bucket>/<path>`) as their stored
 * form. Once migration 044 makes the buckets private that URL answers
 * 400, so anything that renders an attachment asks here for a URL it can
 * actually load.
 *
 * Why `createSignedUrl` through the user's own Supabase client, rather
 * than a server endpoint that signs with the service role: the storage
 * API checks the bucket's SELECT policy against the caller's JWT before
 * it signs, and migration 044's policy is "members of the account that
 * owns the path". So isolation is enforced by exactly the same rule that
 * governs direct reads, there is no service-role code path to audit, and
 * no new route. A user in account B asking to sign account A's object
 * gets an error, not a URL. It also degrades cleanly: on a still-public
 * bucket signing works the same way, and if signing fails for any reason
 * the caller gets the original URL back (which is all that worked before
 * this module existed).
 *
 * URLs live for {@link SIGNED_URL_TTL_SECONDS} and are cached per object;
 * `getSignedMediaUrl` hands back the expiry so a mounted `<video>` or
 * `<img>` can schedule a renewal instead of breaking mid-session.
 */

/** Ten minutes: long enough to view or download, short enough to leak little. */
export const SIGNED_URL_TTL_SECONDS = 600;

/** Re-sign this long before expiry so a renewal never races the deadline. */
export const SIGNED_URL_REFRESH_MARGIN_MS = 60_000;

/** The slice of a Supabase client this needs. Injectable so tests can fake it. */
export interface SignedUrlClient {
  storage: {
    from(bucket: string): {
      createSignedUrl(
        path: string,
        expiresIn: number
      ): Promise<{
        data: { signedUrl: string } | null;
        error: { message: string } | null;
      }>;
    };
  };
}

export interface SignedMediaUrl {
  /** What to put in `src` / `href`. The input URL when no signing applied. */
  url: string;
  /** Epoch ms after which `url` stops working; null when it never expires. */
  expiresAt: number | null;
}

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SignedMediaUrl>>();

/**
 * The browser client, resolved lazily so importing this module from a
 * server-rendered component or a test never constructs one.
 */
async function defaultClient(): Promise<SignedUrlClient> {
  const mod = await import('@/lib/supabase/client');
  return mod.createClient() as unknown as SignedUrlClient;
}

/**
 * Resolve a stored media URL into something the browser can load right
 * now. Non-bucket URLs (the inbound proxy, an external link) are returned
 * as they are.
 */
export async function getSignedMediaUrl(
  url: string,
  opts: {
    client?: SignedUrlClient | (() => Promise<SignedUrlClient>);
    now?: () => number;
    ttlSeconds?: number;
  } = {}
): Promise<SignedMediaUrl> {
  if (!isMediaBucketUrl(url)) return { url, expiresAt: null };

  const now = opts.now ?? Date.now;
  const cached = cache.get(url);
  if (cached && cached.expiresAt - now() > SIGNED_URL_REFRESH_MARGIN_MS) {
    return { url: cached.url, expiresAt: cached.expiresAt };
  }

  const pending = inFlight.get(url);
  if (pending) return pending;

  const load = (async (): Promise<SignedMediaUrl> => {
    const ref = parseStorageObjectUrl(url);
    if (!ref) return { url, expiresAt: null };
    const ttl = opts.ttlSeconds ?? SIGNED_URL_TTL_SECONDS;
    try {
      const client =
        typeof opts.client === 'function'
          ? await opts.client()
          : (opts.client ?? (await defaultClient()));
      const issuedAt = now();
      const { data, error } = await client.storage
        .from(ref.bucket)
        .createSignedUrl(ref.path, ttl);
      if (error || !data?.signedUrl) {
        throw new Error(error?.message ?? 'no signed URL returned');
      }
      const entry: CacheEntry = {
        url: data.signedUrl,
        expiresAt: issuedAt + ttl * 1000,
      };
      cache.set(url, entry);
      return { url: entry.url, expiresAt: entry.expiresAt };
    } catch (err) {
      // Fall back to the stored URL: on a public bucket it still works,
      // and on a private one the element's own error state reports it.
      console.warn(
        '[media] could not sign storage URL, using it as-is:',
        err instanceof Error ? err.message : err
      );
      return { url, expiresAt: null };
    }
  })();

  inFlight.set(url, load);
  try {
    return await load;
  } finally {
    inFlight.delete(url);
  }
}

/**
 * Milliseconds until a signed URL should be renewed — `expiresAt` minus
 * the refresh margin, never below one second so a clock skew can't spin.
 */
export function msUntilRefresh(
  expiresAt: number,
  now: number = Date.now()
): number {
  return Math.max(1_000, expiresAt - SIGNED_URL_REFRESH_MARGIN_MS - now);
}

/** Test seam. */
export function __resetSignedUrlCache(): void {
  cache.clear();
  inFlight.clear();
}
