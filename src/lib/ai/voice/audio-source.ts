import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api';
import { normalizeMimeType } from '@/lib/whatsapp/mirror-inbound-media';
import {
  assertStoragePathOwnedBy,
  parseStorageObjectUrl,
} from '@/lib/media/storage-url';
import type { VoiceFailureReason, VoiceNoteSource } from './types';

const CHAT_MEDIA_BUCKET = 'chat-media';
const MEDIA_PROXY_PREFIX = '/api/whatsapp/media/';

export interface VoiceNoteStorage {
  from(bucket: string): {
    download(
      path: string
    ): Promise<{ data: Blob | null; error: { message: string } | null }>;
  };
}

export interface LoadVoiceNoteAudioArgs {
  accountId: string;
  /** `messages.media_url` as stored by the webhook. */
  mediaUrl: string | null;
  /** `messages.media_type`, e.g. `audio/ogg; codecs=opus`. */
  mediaType: string | null;
  source: VoiceNoteSource;
  /** Service-role Storage client (`db.storage`). */
  storage: VoiceNoteStorage;
  maxBytes: number;
  /** Injected in tests. */
  getUrl?: typeof getMediaUrl;
  download?: typeof downloadMedia;
}

export type LoadedAudio =
  | { ok: true; bytes: Uint8Array; mimeType: string | null }
  | { ok: false; status: 'failed' | 'skipped'; reason: VoiceFailureReason };

const fail = (reason: VoiceFailureReason): LoadedAudio => ({
  ok: false,
  status: 'failed',
  reason,
});

/**
 * n15.1 (R12–R14): the bytes of an inbound voice note, from one of the
 * two places the webhook may have left it — and nowhere else.
 *
 *   1. Our `chat-media` bucket (the inbound mirror): only a canonical
 *      `account-<accountId>/…` path, checked with
 *      `assertStoragePathOwnedBy` BEFORE the service-role download.
 *   2. Meta (no mirror, or the proxy URL): `getMediaUrl` + `downloadMedia`
 *      with the webhook's media id and token. A declared `fileSize` over
 *      the limit is refused without downloading.
 *
 * Any other URL is refused: a service-role caller never fetches an
 * arbitrary link. Never logs the token or the bytes (R31).
 */
export async function loadVoiceNoteAudio(
  args: LoadVoiceNoteAudioArgs
): Promise<LoadedAudio> {
  const {
    accountId,
    mediaUrl,
    mediaType,
    source,
    storage,
    maxBytes,
    getUrl = getMediaUrl,
    download = downloadMedia,
  } = args;
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
  const rowMime = normalizeMimeType(mediaType);

  let bytes: Uint8Array;
  let downloadedMime: string | null = null;

  if (mediaUrl === null || mediaUrl.startsWith(MEDIA_PROXY_PREFIX)) {
    try {
      const meta = await getUrl({
        mediaId: source.metaMediaId,
        accessToken: source.accessToken,
      });
      if (meta.fileSize !== null && meta.fileSize > maxBytes) {
        return { ok: false, status: 'skipped', reason: 'too_large' };
      }
      const got = await download({
        downloadUrl: meta.url,
        accessToken: source.accessToken,
      });
      bytes = new Uint8Array(got.buffer);
      downloadedMime = normalizeMimeType(got.contentType ?? meta.mimeType);
    } catch {
      return fail('download_failed');
    }
  } else {
    const ref = parseStorageObjectUrl(mediaUrl, { origin });
    // Null for another origin AND for a URL on our origin that is not a
    // canonical object (`..`, `%2F`…): both are refused, never fetched.
    if (!ref) return fail('forbidden_path');
    if (ref.bucket !== CHAT_MEDIA_BUCKET) return fail('forbidden_path');
    try {
      if (assertStoragePathOwnedBy(ref, accountId).kind !== 'account') {
        return fail('forbidden_path');
      }
    } catch {
      return fail('forbidden_path');
    }
    try {
      const { data, error } = await storage
        .from(CHAT_MEDIA_BUCKET)
        .download(ref.path);
      if (error || !data) return fail('download_failed');
      bytes = new Uint8Array(await data.arrayBuffer());
      downloadedMime = normalizeMimeType(data.type);
    } catch {
      return fail('download_failed');
    }
  }

  if (bytes.byteLength > maxBytes) {
    return { ok: false, status: 'skipped', reason: 'too_large' };
  }
  return { ok: true, bytes, mimeType: rowMime ?? downloadedMime };
}
