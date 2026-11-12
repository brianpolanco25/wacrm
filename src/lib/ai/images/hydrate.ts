import type { ChatImageRef, ChatMessage } from '../types';
import type { VoiceNoteStorage } from '../voice/audio-source';
import {
  aiImageDownloadTimeoutMs,
  aiImageMaxBytes,
  aiImageMaxPerTurn,
  formatImageTurn,
  stripImageMarker,
} from './config';
import { loadInboundImage, type LoadedImage } from './image-source';
import type { ImageUnavailableReason, InboundImageSource } from './types';

export interface HydrateImagesOptions {
  accountId: string;
  storage: VoiceNoteStorage;
  /** The current inbound: its `messageId` and Meta source (R12). */
  inbound?: { messageId: string; source?: InboundImageSource };
  maxPerTurn?: number;
  maxBytes?: number;
  timeoutMs?: number;
  /** Injected in tests. */
  load?: typeof loadInboundImage;
}

export interface HydrateImagesResult {
  messages: ChatMessage[];
  attached: number;
  unavailable: number;
}

const isRowRef = (image: ChatMessage['image']): image is ChatImageRef =>
  !!image && 'messageId' in image;

/**
 * n15.2 (R9, R12, R14, R28): attach the bytes of the `maxPerTurn` most
 * recent customer images of the context and turn their marker into
 * `[imagen]`; every other image turn stays `[imagen no disponible]`.
 * Loads run in parallel (≤ maxPerTurn). Only the turn of the current
 * inbound gets the Meta `source`. Never throws, never mutates the input,
 * and logs only message ids and reason codes — never bytes (R28).
 */
export async function hydrateConversationImages(
  messages: ChatMessage[],
  opts: HydrateImagesOptions
): Promise<HydrateImagesResult> {
  const maxPerTurn = opts.maxPerTurn ?? aiImageMaxPerTurn();
  const maxBytes = opts.maxBytes ?? aiImageMaxBytes();
  const timeoutMs = opts.timeoutMs ?? aiImageDownloadTimeoutMs();
  const load = opts.load ?? loadInboundImage;

  const candidates: number[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !isRowRef(m.image)) continue;
    total++;
    if (candidates.length < maxPerTurn) candidates.push(i);
  }
  if (total === 0)
    return { messages: [...messages], attached: 0, unavailable: 0 };

  const outcomes = await Promise.all(
    candidates.map(async (i): Promise<LoadedImage> => {
      const ref = messages[i].image as ChatImageRef;
      const source =
        opts.inbound && opts.inbound.messageId === ref.messageId
          ? opts.inbound.source
          : undefined;
      try {
        return await load({
          accountId: opts.accountId,
          mediaUrl: ref.mediaUrl,
          ...(source ? { source } : {}),
          storage: opts.storage,
          maxBytes,
          timeoutMs,
        });
      } catch {
        return { ok: false, reason: 'download_failed' };
      }
    })
  );

  const out = [...messages];
  const reasons: { messageId: string; reason: ImageUnavailableReason }[] = [];
  let attached = 0;
  candidates.forEach((i, k) => {
    const outcome = outcomes[k];
    const m = messages[i];
    if (outcome.ok) {
      attached++;
      out[i] = {
        ...m,
        content: formatImageTurn(stripImageMarker(m.content) || null, true),
        images: [outcome.image],
      };
    } else {
      reasons.push({
        messageId: (m.image as ChatImageRef).messageId,
        reason: outcome.reason,
      });
    }
  });

  const unavailable = total - attached;
  // Only ids and reason codes: the bytes never reach a log (R28).
  console.info('[ai-image] hydrated', {
    attached,
    unavailable,
    ...(reasons.length > 0 ? { reasons } : {}),
    ...(maxPerTurn === 0 ? { disabled: true } : {}),
  });
  return { messages: out, attached, unavailable };
}
