import type { VoiceNoteSource } from './types';
import type { InboundImageSource } from '../images/types';

/**
 * Whether the webhook hands an inbound to the AI auto-reply (R4–R6).
 *
 * Text: exactly as before n15.1 — non-empty text that no flow consumed
 * and that is not an interactive reply. Audio with a Meta media id: the
 * same gates, plus the `voiceNote` the dispatcher needs to fetch it.
 * n15.2 (R1–R3): a photo with a Meta media id (`imageMediaId`, never set
 * for a sticker) dispatches with or without caption, plus the
 * `inboundImage` to fetch it. Any other media without text (sticker,
 * video, document) still does not wake the AI.
 */
export function aiReplyDispatchPlan(args: {
  flowConsumed: boolean;
  interactiveReplyId: string | null | undefined;
  inboundText: string;
  contentType: string;
  audioMediaId: string | null | undefined;
  imageMediaId?: string | null;
  accessToken: string;
}):
  | { dispatch: false }
  | {
      dispatch: true;
      voiceNote?: VoiceNoteSource;
      inboundImage?: InboundImageSource;
    } {
  if (args.flowConsumed || args.interactiveReplyId) return { dispatch: false };
  if (args.contentType === 'image' && args.imageMediaId) {
    return {
      dispatch: true,
      inboundImage: {
        metaMediaId: args.imageMediaId,
        accessToken: args.accessToken,
      },
    };
  }
  if (args.inboundText.trim()) return { dispatch: true };
  if (args.contentType === 'audio' && args.audioMediaId) {
    return {
      dispatch: true,
      voiceNote: {
        metaMediaId: args.audioMediaId,
        accessToken: args.accessToken,
      },
    };
  }
  return { dispatch: false };
}
