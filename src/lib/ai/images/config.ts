// ============================================================
// n15.2 — tunables and pure helpers for customer images. Same
// env-reading pattern as `../voice/config.ts`.
// ============================================================

/** Prefix of a `user` turn whose image bytes ride along (R9). */
export const IMAGE_MARKER = '[imagen]';

/** Prefix of a `user` turn whose image the model cannot see (R6). */
export const IMAGE_UNAVAILABLE_MARKER = '[imagen no disponible]';

/** R33: largest decoded image the playground accepts (2 MiB). */
export const PLAYGROUND_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/** WhatsApp stickers are always `image/webp`; photos are `image/jpeg`. */
export const STICKER_MIME = 'image/webp';

const DEFAULT_MAX_PER_TURN = 3;
/** 3.75 MiB: its base64 stays under Anthropic's 5 MiB per image. */
const DEFAULT_MAX_BYTES = 3_932_160;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 8_000;

function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * How many of the most recent customer images carry bytes per turn.
 * `AI_IMAGE_MAX_PER_TURN`, integer ≥ 0, default 3. `0` is the global
 * switch that turns vision off (unlike `positiveEnv`); anything invalid
 * (blank, negative, fractional, text) → 3 (R10).
 */
export function aiImageMaxPerTurn(): number {
  const raw = process.env.AI_IMAGE_MAX_PER_TURN;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MAX_PER_TURN;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_PER_TURN;
}

/** Largest image we download. `AI_IMAGE_MAX_BYTES`, default 3 932 160. */
export function aiImageMaxBytes(): number {
  return Math.floor(positiveEnv('AI_IMAGE_MAX_BYTES', DEFAULT_MAX_BYTES));
}

/** Per-image download timeout. `AI_IMAGE_DOWNLOAD_TIMEOUT_MS`, 8 s. */
export function aiImageDownloadTimeoutMs(): number {
  return positiveEnv(
    'AI_IMAGE_DOWNLOAD_TIMEOUT_MS',
    DEFAULT_DOWNLOAD_TIMEOUT_MS
  );
}

/** The `user` turn content for an image: marker plus optional caption. */
export function formatImageTurn(
  caption: string | null,
  available: boolean
): string {
  const marker = available ? IMAGE_MARKER : IMAGE_UNAVAILABLE_MARKER;
  const text = caption?.trim();
  return text ? `${marker} ${text}` : marker;
}

/** The caption without either marker (R15); unmarked content as is. */
export function stripImageMarker(content: string): string {
  for (const marker of [IMAGE_UNAVAILABLE_MARKER, IMAGE_MARKER]) {
    if (content.startsWith(marker)) {
      return content.slice(marker.length).trimStart();
    }
  }
  return content;
}
