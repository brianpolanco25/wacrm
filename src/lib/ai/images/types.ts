// ============================================================
// n15.2 — customer images in the AI auto-reply.
// ============================================================

/** What the webhook knows about an inbound image that the stored row
 *  does not: Meta's media id and the token to fetch it with. Never
 *  persisted, never logged. */
export interface InboundImageSource {
  metaMediaId: string;
  accessToken: string;
}

/** Why an image was not attached to the turn. Only reaches logs. */
export type ImageUnavailableReason =
  | 'forbidden_path'
  | 'no_source'
  | 'too_large'
  | 'unsupported_format'
  | 'download_failed'
  | 'timeout'
  | 'disabled';
