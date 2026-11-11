'use client';

import { useTranslations } from 'next-intl';
import type { Message } from '@/types';

/**
 * n15.1 (R33, R34): the transcript of a voice note under its player.
 *
 * - `done`             → «Transcript: …» (the text is a React text node,
 *                        so whatever the customer said is escaped);
 * - `failed`/`skipped` → «could not be transcribed»;
 * - null/absent        → nothing (not transcribed, or not by the bot).
 */
export function VoiceTranscript({
  transcript,
  status,
}: {
  transcript?: Message['transcript'];
  status?: Message['transcript_status'];
}) {
  const t = useTranslations('Inbox.bubble');
  if (status === 'done' && transcript) {
    return (
      <p
        className="text-muted-foreground max-w-72 text-xs whitespace-pre-wrap"
        data-voice-transcript
      >
        <span className="font-medium">{t('transcriptLabel')}:</span>{' '}
        {transcript}
      </p>
    );
  }
  if (status === 'failed' || status === 'skipped') {
    return (
      <p
        className="text-muted-foreground text-xs italic"
        data-voice-transcript-unavailable
      >
        {t('transcriptUnavailable')}
      </p>
    );
  }
  return null;
}
