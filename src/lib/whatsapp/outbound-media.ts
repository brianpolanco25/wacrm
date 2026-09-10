import { uploadMedia } from './meta-api';
import type { SendTimeParams } from './template-send-builder';
import type { MessageTemplate } from '@/types';
import {
  accountIdFromPath,
  legacyOwnerFromPath,
  MEDIA_BUCKETS,
  parseStorageObjectUrl,
} from '@/lib/media/storage-url';

/**
 * Outbound media: turn a stored `media_url` into what Meta needs.
 *
 * Every outbound attachment — composer, public API, Flow `send_media`
 * node, template media headers in broadcasts — used to reach Meta as a
 * public bucket URL that Meta fetched at send time. That is the single
 * reason the media buckets were public. This module breaks the
 * dependency: when a URL points into our own Storage, the bytes are
 * downloaded here with the service role and uploaded to Meta, and the
 * message is sent by **media id**. Anything else (an integrator's own
 * CDN link, say) is still passed through as a `link`.
 *
 * It works with the buckets public or private, which is what allows the
 * deploy order the spec requires: ship this, verify sends still land,
 * THEN apply migration 044.
 *
 * Tenancy: the caller passes `accountId` and the object's path must
 * belong to that account (`account-<id>/…`, or a pre-020 `<uid>/…` path
 * whose uploader is a member of the account). Without this check a
 * public-API caller in account A could name account B's object in
 * `media_url` and have the service role deliver it to A's recipient.
 */

/** Service-role Storage surface this needs. Narrow so tests can fake it. */
export interface OutboundMediaStorage {
  from(bucket: string): {
    download(
      path: string
    ): Promise<{ data: Blob | null; error: { message: string } | null }>;
  };
}

/**
 * Profile lookup used to vouch for a legacy `<uid>/…` path. Typed as
 * loosely as possible on purpose: a real `SupabaseClient` satisfies it
 * without TypeScript trying to unify the whole PostgREST builder against
 * a structural type (which blows the instantiation depth), and tests can
 * hand in a plain object.
 */
export interface OutboundMediaDb {
  from(table: string): unknown;
}

/** The one query shape `assertMediaPathOwnedBy` runs against `profiles`. */
interface ProfileLookup {
  select(columns: string): {
    eq(
      column: string,
      value: unknown
    ): {
      eq(
        column: string,
        value: unknown
      ): {
        maybeSingle(): PromiseLike<{
          data: Record<string, unknown> | null;
          error: unknown;
        }>;
      };
    };
  };
}

export type ResolvedOutboundMedia = { mediaId: string } | { link: string };

export interface ResolveOutboundMediaArgs {
  mediaUrl: string;
  /** Tenant the send runs for — the object must belong to it. */
  accountId: string;
  phoneNumberId: string;
  accessToken: string;
  /** Service-role `supabase.storage`. */
  storage: OutboundMediaStorage;
  /**
   * Service-role client, only consulted for legacy `<uid>/…` paths to
   * confirm the uploader belongs to `accountId`. Optional: without it
   * legacy paths are refused.
   */
  db?: OutboundMediaDb;
  /** Document filename to hand Meta; defaults to the object's basename. */
  fileName?: string | null;
  /** Injected in tests. */
  upload?: typeof uploadMedia;
  now?: () => number;
}

export class OutboundMediaError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'upload_failed';
  constructor(code: OutboundMediaError['code'], message: string) {
    super(message);
    this.name = 'OutboundMediaError';
    this.code = code;
  }
}

// ------------------------------------------------------------------
// Media-id cache
//
// A Flow that sends the same brochure to a thousand contacts, or a
// broadcast with an image header, would otherwise download + upload the
// same bytes once per recipient. Meta keeps an uploaded media id for
// ~30 days; we cache it per (phone number, object) for a day, in this
// process only. Persisting the id (a small table keyed on
// phone_number_id + bucket + path) is the natural next step and is
// noted as debt in docs/security.md — it was left out so migration 044
// stays a pure privatisation step.
// ------------------------------------------------------------------

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const mediaIdCache = new Map<string, { mediaId: string; expiresAt: number }>();

function cacheKey(phoneNumberId: string, bucket: string, path: string): string {
  return `${phoneNumberId}|${bucket}/${path}`;
}

function cacheGet(key: string, now: number): string | null {
  const hit = mediaIdCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    mediaIdCache.delete(key);
    return null;
  }
  // Refresh recency — Map iteration order gives LRU eviction for free.
  mediaIdCache.delete(key);
  mediaIdCache.set(key, hit);
  return hit.mediaId;
}

function cacheSet(key: string, mediaId: string, now: number): void {
  mediaIdCache.set(key, { mediaId, expiresAt: now + CACHE_TTL_MS });
  while (mediaIdCache.size > CACHE_MAX) {
    const oldest = mediaIdCache.keys().next().value;
    if (oldest === undefined) break;
    mediaIdCache.delete(oldest);
  }
}

/** Test seam. */
export function __resetOutboundMediaCache(): void {
  mediaIdCache.clear();
}

// ------------------------------------------------------------------

/** MIME type for an object whose Blob came back untyped, by extension. */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
};

function mimeTypeFor(blob: Blob, path: string): string {
  const typed = blob.type.split(';')[0].trim().toLowerCase();
  if (typed && typed !== 'application/octet-stream') return typed;
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * Confirm the object at `path` belongs to `accountId`. Account-scoped
 * paths are decided by their first segment; legacy uid paths need the
 * uploader's profile to sit in the account.
 */
export async function assertMediaPathOwnedBy(
  path: string,
  accountId: string,
  db?: OutboundMediaDb
): Promise<void> {
  const owner = accountIdFromPath(path);
  if (owner) {
    if (owner === accountId) return;
    throw new OutboundMediaError(
      'forbidden',
      'media_url points at an attachment that belongs to another account'
    );
  }

  const legacyUid = legacyOwnerFromPath(path);
  if (legacyUid && db) {
    const { data } = await (db.from('profiles') as ProfileLookup)
      .select('user_id')
      .eq('user_id', legacyUid)
      .eq('account_id', accountId)
      .maybeSingle();
    if (data) return;
  }
  throw new OutboundMediaError(
    'forbidden',
    'media_url points at an attachment that belongs to another account'
  );
}

/**
 * Resolve a `media_url` for sending. Our own bucket objects come back as
 * `{ mediaId }` after an ownership check, a download and an upload to
 * Meta (cached); anything else is returned untouched as `{ link }`.
 */
export async function resolveOutboundMedia(
  args: ResolveOutboundMediaArgs
): Promise<ResolvedOutboundMedia> {
  const { mediaUrl, accountId, phoneNumberId, accessToken, storage, db } = args;
  const upload = args.upload ?? uploadMedia;
  const now = args.now ?? Date.now;

  const ref = parseStorageObjectUrl(mediaUrl, {
    origin: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  if (!ref || !MEDIA_BUCKETS.has(ref.bucket)) {
    return { link: mediaUrl };
  }

  await assertMediaPathOwnedBy(ref.path, accountId, db);

  const key = cacheKey(phoneNumberId, ref.bucket, ref.path);
  const cached = cacheGet(key, now());
  if (cached) return { mediaId: cached };

  const { data, error } = await storage.from(ref.bucket).download(ref.path);
  if (error || !data) {
    throw new OutboundMediaError(
      'not_found',
      `Attachment could not be read from storage${error ? `: ${error.message}` : ''}`
    );
  }

  const bytes = new Uint8Array(await data.arrayBuffer());
  const fileName = args.fileName || ref.path.split('/').pop() || 'file';
  let mediaId: string;
  try {
    ({ mediaId } = await upload({
      phoneNumberId,
      accessToken,
      bytes,
      mimeType: mimeTypeFor(data, ref.path),
      fileName,
    }));
  } catch (err) {
    throw new OutboundMediaError(
      'upload_failed',
      `Meta rejected the attachment upload: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  cacheSet(key, mediaId, now());
  return { mediaId };
}

/**
 * Template media headers (image / video / document) ride on every send
 * as a `link` or an `id`. When the effective link — the per-send
 * override or the template's stored `header_media_url` — is one of our
 * bucket objects, swap it for a media id so the header no longer depends
 * on the bucket being public. Returns the params to pass on; a template
 * without a media header, or one whose header already carries an id,
 * comes back unchanged.
 */
export async function resolveTemplateHeaderMedia(
  template: MessageTemplate | null | undefined,
  params: SendTimeParams | undefined,
  ctx: Omit<ResolveOutboundMediaArgs, 'mediaUrl' | 'fileName'>
): Promise<SendTimeParams | undefined> {
  if (!template) return params;
  const headerType = template.header_type;
  if (
    headerType !== 'image' &&
    headerType !== 'video' &&
    headerType !== 'document'
  ) {
    return params;
  }
  if (params?.headerMediaId) return params;

  const link = params?.headerMediaUrl ?? template.header_media_url;
  if (!link) return params;

  const resolved = await resolveOutboundMedia({ ...ctx, mediaUrl: link });
  if ('link' in resolved) return params;
  return {
    ...(params ?? {}),
    headerMediaUrl: undefined,
    headerMediaId: resolved.mediaId,
  };
}
