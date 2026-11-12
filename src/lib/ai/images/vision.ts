import type { AiProvider, ChatMessage } from '../types';
import { formatImageTurn, stripImageMarker } from './config';

/**
 * Conservative deny-list of models known to take no images (R22). Any
 * other model is assumed to see; an unknown text-only model is covered by
 * the single retry without images in `generateReply` (D5).
 */
const NO_VISION: Record<AiProvider, RegExp | null> = {
  openai: /^(gpt-3\.5|o1-mini|o3-mini|gpt-4(-0314|-0613)?$)/,
  anthropic: /^claude-(instant|2)/,
  gemini: null,
};

export function modelSupportsVision(
  provider: AiProvider,
  model: string
): boolean {
  const re = NO_VISION[provider];
  return !(re && re.test(model.trim()));
}

/**
 * The transcript with every image dropped: `images` removed and each
 * image turn rewritten to `[imagen no disponible]` (caption kept). Turns
 * without `image` are passed through untouched. Pure; never mutates.
 */
export function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!m.image && !m.images) return m;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { images, ...rest } = m;
    if (!m.image) return rest;
    return {
      ...rest,
      content: formatImageTurn(stripImageMarker(m.content) || null, false),
    };
  });
}
