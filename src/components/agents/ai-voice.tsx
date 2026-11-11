'use client';

// ============================================================
// n15.1 (R37): simulated voice notes in the playground. Presentational
// bits kept apart from `ai-playground.tsx` so they can be tested with
// `renderToStaticMarkup`, plus the pure body builder.
// ============================================================

import { Mic } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface PlaygroundTurnLike {
  role: 'user' | 'assistant';
  content: string;
  /** user-only: sent as a simulated voice note. */
  voice?: boolean;
}

/**
 * The `messages` the playground route receives: role + content, and
 * `voice: true` only on the user turns marked as voice notes.
 */
export function playgroundRequestMessages(
  turns: PlaygroundTurnLike[]
): { role: 'user' | 'assistant'; content: string; voice?: true }[] {
  return turns.map((t) =>
    t.role === 'user' && t.voice === true
      ? { role: t.role, content: t.content, voice: true }
      : { role: t.role, content: t.content }
  );
}

/** Toggle next to «send»: the next message goes as a voice note. */
export function VoiceNoteToggle({
  pressed,
  onToggle,
  disabled,
}: {
  pressed: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations('AiVoice');
  return (
    <Button
      type="button"
      size="sm"
      variant={pressed ? 'secondary' : 'ghost'}
      aria-pressed={pressed}
      aria-label={t('sendAsVoice')}
      title={t('sendAsVoiceHint')}
      onClick={onToggle}
      disabled={disabled}
      className={cn('h-9 w-9 shrink-0 p-0', pressed && 'text-primary')}
    >
      <Mic className="h-4 w-4" aria-hidden />
    </Button>
  );
}

/** Label shown on a user turn that was sent as a simulated voice note. */
export function SimulatedVoiceNoteLabel() {
  const t = useTranslations('AiVoice');
  return (
    <p
      className="mb-1 flex items-center gap-1 text-xs opacity-80"
      data-simulated-voice-note
    >
      <Mic className="h-3 w-3" aria-hidden />
      {t('simulatedVoiceNote')}
    </p>
  );
}
