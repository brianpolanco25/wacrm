import type { VoiceNoteSource } from './types';

/**
 * Whether the webhook hands an inbound to the AI auto-reply (R4–R6).
 *
 * Text: exactly as before n15.1 — non-empty text that no flow consumed
 * and that is not an interactive reply. Audio with a Meta media id: the
 * same gates, plus the `voiceNote` the dispatcher needs to fetch it.
 * Any other media without text still does not wake the AI.
 */
export function aiReplyDispatchPlan(args: {
  flowConsumed: boolean;
  interactiveReplyId: string | null | undefined;
  inboundText: string;
  contentType: string;
  audioMediaId: string | null | undefined;
  accessToken: string;
}): { dispatch: false } | { dispatch: true; voiceNote?: VoiceNoteSource } {
  if (args.flowConsumed || args.interactiveReplyId) return { dispatch: false };
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
