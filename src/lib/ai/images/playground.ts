import type { ChatImage, ChatMessage } from '../types';
import { formatVoiceNote } from '../voice/config';
import {
  ALLOWED_IMAGE_MIME,
  formatImageTurn,
  PLAYGROUND_IMAGE_MAX_BYTES,
} from './config';
import { sniffImageMime } from './sniff';

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * n15.2 (R33): a playground image `{ mimeType, data }` from the request
 * body, or null when it is not one we accept: MIME outside JPEG/PNG/WebP,
 * invalid base64, more than 2 MiB decoded, or magic bytes that do not
 * match the declared MIME.
 */
export function parsePlaygroundImage(raw: unknown): ChatImage | null {
  if (!raw || typeof raw !== 'object') return null;
  const { mimeType, data } = raw as { mimeType?: unknown; data?: unknown };
  if (
    typeof mimeType !== 'string' ||
    !(ALLOWED_IMAGE_MIME as readonly string[]).includes(mimeType)
  ) {
    return null;
  }
  if (typeof data !== 'string' || data.length % 4 !== 0) return null;
  // Cheap bound before decoding: 4 base64 chars → 3 bytes.
  if ((data.length / 4) * 3 > PLAYGROUND_IMAGE_MAX_BYTES + 2) return null;
  if (!BASE64_RE.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > PLAYGROUND_IMAGE_MAX_BYTES) {
    return null;
  }
  if (sniffImageMime(bytes) !== mimeType) return null;
  return { mimeType: mimeType as ChatImage['mimeType'], data };
}

interface RawTurn {
  role?: unknown;
  content?: unknown;
  voice?: unknown;
  image?: unknown;
  imageOmitted?: unknown;
}

/**
 * The playground transcript as the bot would see it (n15.1 R36, n15.2
 * R32–R34). Keeps `user`/`assistant` turns with string content; a `user`
 * turn may have empty text when it carries an image (`image`) or a
 * replaced one (`imageOmitted: true`). A `user` image turn becomes
 * `[imagen] <text>` with bytes when it is among the `maxPerTurn` most
 * recent valid images, and `[imagen no disponible] <text>` otherwise —
 * the same selection as `hydrateConversationImages`. `image` on an
 * assistant turn is ignored. Any invalid image → `invalid_image`.
 */
export function toPlaygroundMessages(
  raw: unknown[],
  opts: { maxTurns: number; maxPerTurn: number }
):
  { ok: true; messages: ChatMessage[] } | { ok: false; code: 'invalid_image' } {
  type Parsed = {
    role: 'user' | 'assistant';
    text: string;
    voice: boolean;
    image: ChatImage | null;
    imageTurn: boolean;
  };
  const parsed: Parsed[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as RawTurn;
    if (t.role !== 'user' && t.role !== 'assistant') continue;
    if (typeof t.content !== 'string') continue;
    const isUser = t.role === 'user';
    const hasImage = isUser && t.image !== undefined && t.image !== null;
    const omitted = isUser && t.imageOmitted === true;
    let image: ChatImage | null = null;
    if (hasImage) {
      image = parsePlaygroundImage(t.image);
      if (!image) return { ok: false, code: 'invalid_image' };
    }
    const imageTurn = hasImage || omitted;
    if (!imageTurn && t.content.trim().length === 0) continue;
    parsed.push({
      role: t.role,
      text: t.content,
      voice: isUser && t.voice === true,
      image,
      imageTurn,
    });
  }

  const turns = parsed.slice(-opts.maxTurns);
  let budget = opts.maxPerTurn;
  const withBytes = new Set<number>();
  for (let i = turns.length - 1; i >= 0 && budget > 0; i--) {
    if (turns[i].image) {
      withBytes.add(i);
      budget--;
    }
  }

  const messages = turns.map((t, i): ChatMessage => {
    if (t.imageTurn) {
      const attached = withBytes.has(i);
      return {
        role: 'user',
        content: formatImageTurn(t.text.trim() || null, attached),
        image: { playground: true },
        ...(attached && t.image ? { images: [t.image] } : {}),
      };
    }
    if (t.voice) {
      return {
        role: 'user',
        content: formatVoiceNote(t.text.trim()),
        voice: true,
      };
    }
    return { role: t.role, content: t.text };
  });
  return { ok: true, messages };
}
