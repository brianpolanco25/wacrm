import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api';
import {
  assertStoragePathOwnedBy,
  parseStorageObjectUrl,
} from '@/lib/media/storage-url';
import type { VoiceNoteStorage } from '../voice/audio-source';
import type { ChatImage } from '../types';
import { sniffImageMime } from './sniff';
import type { ImageUnavailableReason, InboundImageSource } from './types';

const CHAT_MEDIA_BUCKET = 'chat-media';
const MEDIA_PROXY_PREFIX = '/api/whatsapp/media/';

export interface LoadInboundImageArgs {
  accountId: string;
  /** `messages.media_url` as stored by the webhook. */
  mediaUrl: string | null;
  /** Only for the current inbound: enables the download from Meta. */
  source?: InboundImageSource;
  /** Service-role Storage client (`db.storage`). */
  storage: VoiceNoteStorage;
  maxBytes: number;
  timeoutMs: number;
  /** Injected in tests. */
  getUrl?: typeof getMediaUrl;
  download?: typeof downloadMedia;
}

export type LoadedImage =
  | { ok: true; image: ChatImage }
  | { ok: false; reason: ImageUnavailableReason };

const fail = (reason: ImageUnavailableReason): LoadedImage => ({
  ok: false,
  reason,
});

class Timeout extends Error {}

/** Race `work` against `ms`; the timer never outlives the race. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * n15.2 (R11–R14): the bytes of a customer image, from one of the two
 * places the webhook may have left it — and nowhere else (same rules as
 * `loadVoiceNoteAudio`, ../voice/audio-source.ts):
 *
 *   1. Our `chat-media` bucket (inbound mirror): only a canonical
 *      `account-<accountId>/…` path, checked with
 *      `assertStoragePathOwnedBy` BEFORE the service-role download.
 *   2. Meta (no mirror, or the proxy URL): only for the current inbound,
 *      which is the only one the webhook gave us a media id + token for.
 *      A declared `fileSize` over the limit is refused without
 *      downloading. An older image with a proxy URL → `no_source`.
 *
 * The MIME sent on is the one sniffed from the bytes (R13). Never throws;
 * never logs the token or the bytes (R28).
 */
export async function loadInboundImage(
  args: LoadInboundImageArgs
): Promise<LoadedImage> {
  const {
    accountId,
    mediaUrl,
    source,
    storage,
    maxBytes,
    timeoutMs,
    getUrl = getMediaUrl,
    download = downloadMedia,
  } = args;

  let bytes: Uint8Array;
  try {
    const got = await withTimeout(
      fetchBytes({
        accountId,
        mediaUrl,
        source,
        storage,
        maxBytes,
        getUrl,
        download,
      }),
      timeoutMs
    );
    if (!got.ok) return got;
    bytes = got.bytes;
  } catch (err) {
    return fail(err instanceof Timeout ? 'timeout' : 'download_failed');
  }

  if (bytes.byteLength > maxBytes) return fail('too_large');
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) return fail('unsupported_format');
  return {
    ok: true,
    image: { mimeType, data: Buffer.from(bytes).toString('base64') },
  };
}

async function fetchBytes(args: {
  accountId: string;
  mediaUrl: string | null;
  source?: InboundImageSource;
  storage: VoiceNoteStorage;
  maxBytes: number;
  getUrl: typeof getMediaUrl;
  download: typeof downloadMedia;
}): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: ImageUnavailableReason }
> {
  const { accountId, mediaUrl, source, storage, maxBytes, getUrl, download } =
    args;

  if (mediaUrl === null || mediaUrl.startsWith(MEDIA_PROXY_PREFIX)) {
    if (!source) return { ok: false, reason: 'no_source' };
    const meta = await getUrl({
      mediaId: source.metaMediaId,
      accessToken: source.accessToken,
    });
    if (meta.fileSize !== null && meta.fileSize > maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
    const got = await download({
      downloadUrl: meta.url,
      accessToken: source.accessToken,
    });
    return { ok: true, bytes: new Uint8Array(got.buffer) };
  }

  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
  const ref = parseStorageObjectUrl(mediaUrl, { origin });
  // Null for another origin AND for a non-canonical object on ours
  // (`..`, `%2F`…): both refused, never fetched.
  if (!ref || ref.bucket !== CHAT_MEDIA_BUCKET) {
    return { ok: false, reason: 'forbidden_path' };
  }
  try {
    if (assertStoragePathOwnedBy(ref, accountId).kind !== 'account') {
      return { ok: false, reason: 'forbidden_path' };
    }
  } catch {
    return { ok: false, reason: 'forbidden_path' };
  }
  const { data, error } = await storage
    .from(CHAT_MEDIA_BUCKET)
    .download(ref.path);
  if (error || !data) return { ok: false, reason: 'download_failed' };
  return { ok: true, bytes: new Uint8Array(await data.arrayBuffer()) };
}
