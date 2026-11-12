'use client';

// ============================================================
// n15.2 (R35, R36): test images in the playground. Presentational bits
// kept apart from `ai-playground.tsx` so they can be tested with
// `renderToStaticMarkup`, plus the pure body builder and file check.
// ============================================================

import { useRef } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  ALLOWED_IMAGE_MIME,
  PLAYGROUND_IMAGE_MAX_BYTES,
} from '@/lib/ai/images/config';
import { playgroundRequestMessages, type PlaygroundTurnLike } from './ai-voice';

/** Same default as `AI_IMAGE_MAX_PER_TURN` on the server. */
export const PLAYGROUND_IMAGES_WITH_BYTES = 3;

export type PlaygroundImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

export interface PlaygroundImage {
  mimeType: PlaygroundImageMime;
  /** base64 without the `data:` prefix — what the route receives. */
  data: string;
  /** The data URL, for the thumbnail. Never sent. */
  previewUrl: string;
}

export interface PlaygroundImageTurnLike extends PlaygroundTurnLike {
  /** user-only: the test image of this turn. */
  image?: PlaygroundImage;
}

export type PlaygroundRequestMessage = ReturnType<
  typeof playgroundRequestMessages
>[number] & {
  image?: { mimeType: PlaygroundImageMime; data: string };
  imageOmitted?: true;
};

/**
 * The `messages` the playground route receives (R35): the voice body of
 * `playgroundRequestMessages`, plus the bytes of only the `maxWithBytes`
 * most recent user images; older image turns go as `imageOmitted: true`
 * so the request stays small (the route would ignore their bytes anyway).
 */
export function playgroundImageMessages(
  turns: PlaygroundImageTurnLike[],
  maxWithBytes: number = PLAYGROUND_IMAGES_WITH_BYTES
): PlaygroundRequestMessage[] {
  const base: PlaygroundRequestMessage[] = playgroundRequestMessages(turns);
  let budget = maxWithBytes;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== 'user' || !turn.image) continue;
    if (budget > 0) {
      base[i] = {
        ...base[i],
        image: { mimeType: turn.image.mimeType, data: turn.image.data },
      };
      budget--;
    } else {
      base[i] = { ...base[i], imageOmitted: true };
    }
  }
  return base;
}

/** R35: client-side check before reading the file; returns the `AiImage`
 *  key of the error, or null when the file is acceptable. */
export function imageFileError(file: {
  type: string;
  size: number;
}): 'unsupportedType' | 'tooLarge' | null {
  if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.type)) {
    return 'unsupportedType';
  }
  if (file.size > PLAYGROUND_IMAGE_MAX_BYTES) return 'tooLarge';
  return null;
}

/** Read a picked file into a `PlaygroundImage` (data URL → base64). */
export function readImageFile(file: File): Promise<PlaygroundImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const comma = url.indexOf(',');
      if (comma < 0) {
        reject(new Error('unreadable image'));
        return;
      }
      resolve({
        mimeType: file.type as PlaygroundImageMime,
        data: url.slice(comma + 1),
        previewUrl: url,
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Button next to «send»: pick one JPEG/PNG/WebP for the next message. */
export function ImageAttachButton({
  onPick,
  onError,
  disabled,
}: {
  onPick: (image: PlaygroundImage) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('AiImage');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still fires `change`.
    e.target.value = '';
    if (!file) return;
    const error = imageFileError(file);
    if (error) {
      onError(t(error));
      return;
    }
    try {
      onPick(await readImageFile(file));
    } catch {
      onError(t('invalidImage'));
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_IMAGE_MIME.join(',')}
        hidden
        onChange={handleChange}
        data-image-input
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={t('attach')}
        title={t('costHint')}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="h-9 w-9 shrink-0 p-0"
      >
        <ImagePlus className="h-4 w-4" aria-hidden />
      </Button>
    </>
  );
}

/** Thumbnail of the image waiting to be sent, with «remove». */
export function AttachedImagePreview({
  image,
  onRemove,
  disabled,
}: {
  image: PlaygroundImage;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations('AiImage');
  return (
    <div className="flex items-center gap-2" data-attached-image>
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL local, sin optimizar */}
      <img
        src={image.previewUrl}
        alt={t('attached')}
        className="border-border h-12 w-12 rounded-md border object-cover"
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={t('remove')}
        onClick={onRemove}
        disabled={disabled}
        className="h-7 w-7 p-0"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}

/** R36: what an image costs, shown next to the attach button. */
export function ImageCostHint() {
  const t = useTranslations('AiImage');
  return (
    <p className="text-muted-foreground text-xs" data-image-cost-hint>
      {t('costHint')}
    </p>
  );
}

/** The image of a sent user turn, above its text. */
export function TurnImage({ image }: { image: PlaygroundImage }) {
  const t = useTranslations('AiImage');
  return (
    // eslint-disable-next-line @next/next/no-img-element -- data URL local, sin optimizar
    <img
      src={image.previewUrl}
      alt={t('attached')}
      className="mb-1 max-h-48 max-w-full rounded-lg object-contain"
    />
  );
}
