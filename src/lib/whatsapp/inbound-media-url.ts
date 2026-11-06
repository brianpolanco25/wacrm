import { getMediaUrl } from '@/lib/whatsapp/meta-api';
import {
  mirrorInboundMedia,
  type MirrorStorage,
} from '@/lib/whatsapp/mirror-inbound-media';

/**
 * The `media_url` to store for a piece of WhatsApp media Meta delivered
 * to us by id — an inbound message's attachment, or (m14.2) the media of
 * an echo the business sent from the phone in coexistence.
 *
 * Extracted from the inbound webhook's `verifyAndBuildUrl` without a
 * change in behaviour:
 *
 *   1. `getMediaUrl` verifies the id with Meta and returns the CDN URL.
 *      getMediaUrl's signature is (mediaId, accessToken) — earlier code
 *      had the args swapped, so every verification hit an invalid Meta
 *      URL and images showed up as empty bubbles in the inbox.
 *   2. When `mirror` is given (the account's
 *      `whatsapp_config.mirror_inbound_media`, migration 039), the bytes
 *      are COPIED into the `chat-media` bucket (issue #466): Meta deletes
 *      media ~30 days after receipt, so the proxy URL is a pointer with
 *      an expiry date on it. The mirror is strictly best-effort —
 *      `mirrorInboundMedia` swallows its own failures and returns null.
 *   3. Otherwise, or when the mirror failed, the proxy
 *      `/api/whatsapp/media/<id>`, which re-fetches from Meta on view.
 *   4. null when Meta could not verify the id. Never throws: a webhook
 *      that throws would have Meta retry the delivery and re-run
 *      everything downstream, far worse than a missing attachment.
 *
 * The access token is only forwarded to Meta; it is never returned,
 * stored or logged here.
 */
export interface ResolveInboundMediaUrlArgs {
  mediaId: string;
  accessToken: string;
  /** Null disables mirroring, which is what the account-level toggle does. */
  mirror: { storage: MirrorStorage; accountId: string } | null;
  /** `document.filename`, so the mirrored object keeps the sender's name. */
  fileName?: string | null;
  /** Meta's message timestamp (epoch seconds) — keeps download names distinct. */
  messageTimestamp?: string | number | null;
}

export async function resolveInboundMediaUrl(
  args: ResolveInboundMediaUrlArgs
): Promise<string | null> {
  const { mediaId, accessToken, mirror, fileName, messageTimestamp } = args;
  try {
    const info = await getMediaUrl({ mediaId, accessToken });

    if (mirror) {
      const mirrored = await mirrorInboundMedia({
        storage: mirror.storage,
        accountId: mirror.accountId,
        mediaId,
        downloadUrl: info.url,
        accessToken,
        mimeType: info.mimeType,
        fileSize: info.fileSize,
        fileName,
        messageTimestamp,
      });
      if (mirrored) return mirrored;
    }

    return `/api/whatsapp/media/${mediaId}`;
  } catch (error) {
    console.error(
      `Failed to verify media ${mediaId} with Meta:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
