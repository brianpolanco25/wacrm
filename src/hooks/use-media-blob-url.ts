'use client';

import { useEffect, useState } from 'react';
import { isProxiedMediaUrl, loadMediaBlob } from '@/lib/media/blob-cache';
import { getSignedMediaUrl, msUntilRefresh } from '@/lib/media/signed-url';
import { isMediaBucketUrl } from '@/lib/media/storage-url';

export type MediaLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface MediaSrcState {
  /** Ready-to-render URL: the original, a signed URL, or an object URL. */
  src: string | null;
  status: MediaLoadStatus;
}

/** A settled load, tagged with the URL it belongs to. */
interface ResolvedMedia {
  url: string;
  src: string | null;
  failed: boolean;
}

/**
 * A `media_url` is one of three things, each loaded differently:
 *
 *   - `/api/whatsapp/media/<id>` — our auth-gated inbound proxy. Images
 *     are pulled through `loadMediaBlob` (credentialed, cached) into an
 *     object URL; video/audio use the path directly so they stream.
 *   - one of our Storage bucket objects — needs a short-lived signed URL
 *     (`@/lib/media/signed-url`), renewed before it expires while the
 *     element stays mounted. Works whether the bucket is still public or
 *     already private (migration 044).
 *   - anything else — an external link, rendered as-is.
 */
type MediaKind = 'proxy' | 'bucket' | 'plain';

function kindOf(url: string): MediaKind {
  if (isProxiedMediaUrl(url)) return 'proxy';
  if (isMediaBucketUrl(url)) return 'bucket';
  return 'plain';
}

/**
 * Shared loader. `blobForProxy` decides what a proxy URL becomes: an
 * object URL (images) or the plain path (streaming media).
 */
function useResolvedMedia(
  url: string | undefined,
  blobForProxy: boolean
): MediaSrcState {
  const [resolved, setResolved] = useState<ResolvedMedia | null>(null);

  useEffect(() => {
    if (!url) return;
    const kind = kindOf(url);
    if (kind === 'plain') return;
    if (kind === 'proxy' && !blobForProxy) return;

    let cancelled = false;
    // Held in a local rather than read back off state, because that is
    // exactly the bug this replaces: the previous implementation's cleanup
    // closed over a `src` that was still null when the effect ran, so no
    // object URL was ever revoked.
    let objectUrl: string | null = null;
    let renewTimer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      if (kind === 'proxy') {
        const blob = await loadMediaBlob(url);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved({ url, src: objectUrl, failed: false });
        return;
      }
      const signed = await getSignedMediaUrl(url);
      if (cancelled) return;
      setResolved({ url, src: signed.url, failed: false });
      // Renew before the signed URL dies so a thread left open for a
      // while keeps working; a `null` expiry is a URL that never does.
      if (signed.expiresAt !== null) {
        renewTimer = setTimeout(() => {
          load().catch(() => {
            /* keep showing the last good URL */
          });
        }, msUntilRefresh(signed.expiresAt));
      }
    };

    load().catch(() => {
      if (cancelled) return;
      setResolved({ url, src: null, failed: true });
    });

    return () => {
      cancelled = true;
      if (renewTimer) clearTimeout(renewTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, blobForProxy]);

  if (!url) return { src: null, status: 'idle' };

  const kind = kindOf(url);
  // Nothing to load for a plain URL (or a streaming proxy URL) — derived
  // here rather than pushed through state so the first paint has it.
  if (kind === 'plain' || (kind === 'proxy' && !blobForProxy)) {
    return { src: url, status: 'ready' };
  }

  // A result for a *previous* URL is stale; the new URL's load is already
  // in flight, so report loading rather than flashing the old media.
  if (resolved?.url === url) {
    return resolved.failed
      ? { src: null, status: 'error' }
      : { src: resolved.src, status: 'ready' };
  }

  return { src: null, status: 'loading' };
}

/**
 * Resolve a `messages.media_url` into something an `<img>` can render.
 *
 * Only use this for images. Video and audio must keep a plain URL so the
 * element streams instead of buffering up to 16 MB before it plays —
 * use {@link useMediaSrc} for those.
 */
export function useMediaBlobUrl(url: string | undefined): MediaSrcState {
  return useResolvedMedia(url, true);
}

/**
 * Resolve a `media_url` into a URL for `<video src>`, `<audio src>` or an
 * `<a href>`: bucket objects become signed URLs (renewed on expiry),
 * everything else is passed straight through.
 */
export function useMediaSrc(url: string | undefined): MediaSrcState {
  return useResolvedMedia(url, false);
}
