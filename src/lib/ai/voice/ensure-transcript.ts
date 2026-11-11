import type { SupabaseClient } from '@supabase/supabase-js';
import { AiError, type AiConfig, type ProviderResult } from '../types';
import { logAiUsage } from '../usage';
import { isTransientTranscribeError } from '../providers/transcribe-errors';
import { loadVoiceNoteAudio, type VoiceNoteStorage } from './audio-source';
import {
  aiTranscribeTimeoutMs,
  aiVoiceMaxBytes,
  aiVoiceMaxSeconds,
  cleanTranscript,
  TRANSCRIBE_RETRY_DELAY_MS,
} from './config';
import { oggOpusDurationSeconds } from './ogg-duration';
import { resolveTranscriber, TRANSCRIBE_MIME } from './resolve-transcriber';
import { transcribeAudio } from './transcribe';
import type {
  TranscriptOutcome,
  TranscriptStatus,
  VoiceFailureReason,
  VoiceNoteSource,
} from './types';

interface MessageRow {
  content_type: string | null;
  sender_type: string | null;
  media_url: string | null;
  media_type: string | null;
  transcript: string | null;
  transcript_status: TranscriptStatus | null;
}

export interface EnsureVoiceTranscriptArgs {
  /** Service-role client. */
  db: SupabaseClient;
  accountId: string;
  /** Already verified against `account_id` by the dispatcher (R32):
   *  `messages` has no `account_id`, so this is what scopes the row. */
  conversationId: string;
  messageId: string;
  config: AiConfig;
  source: VoiceNoteSource;
  deps?: {
    transcribe?: typeof transcribeAudio;
    loadAudio?: typeof loadVoiceNoteAudio;
    sleep?: (ms: number) => Promise<void>;
  };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Map the error of the last transcription attempt to a log reason. */
function reasonFor(err: unknown): VoiceFailureReason {
  if (err instanceof AiError) {
    switch (err.code) {
      case 'timeout':
      case 'network_error':
      case 'invalid_key':
      case 'rate_limited':
        return err.code;
    }
  }
  return 'provider_error';
}

/**
 * n15.1 (R8, R14–R23, R30–R32): make sure an inbound voice note has a
 * transcript, transcribing it at most once.
 *
 * Runs after the dispatcher won the per-message reservation (D1). Reuses
 * a stored result; otherwise resolves the transcriber, loads the audio
 * under the size/duration/format limits, calls the provider (one retry
 * on a transient failure, R19), logs the cost as `transcription` with
 * the TRANSCRIBER's provider/model/key source, and stores the outcome
 * with an UPDATE guarded by `transcript_status IS NULL`.
 *
 * Never throws. Logs carry the message id, the reason and the attempt
 * count — never the transcript, the bytes or the token (R31).
 */
export async function ensureVoiceTranscript(
  args: EnsureVoiceTranscriptArgs
): Promise<TranscriptOutcome> {
  const { db, accountId, conversationId, messageId, config, source } = args;
  const transcribe = args.deps?.transcribe ?? transcribeAudio;
  const loadAudio = args.deps?.loadAudio ?? loadVoiceNoteAudio;
  const sleep = args.deps?.sleep ?? defaultSleep;
  let attempts = 0;

  const log = (outcome: TranscriptOutcome) => {
    const detail = outcome.status === 'done' ? 'ok' : outcome.reason;
    const line = `[ai voice] message ${messageId} transcript ${outcome.status} (${detail}, attempts ${attempts})`;
    if (outcome.status === 'done') console.info(line);
    else console.warn(line);
  };

  const persist = async (outcome: TranscriptOutcome) => {
    const { error } = await db
      .from('messages')
      .update(
        outcome.status === 'done'
          ? { transcript: outcome.text, transcript_status: 'done' }
          : { transcript: null, transcript_status: outcome.status }
      )
      .eq('id', messageId)
      .eq('conversation_id', conversationId)
      .is('transcript_status', null);
    if (error) {
      // R22: the turn goes on with the in-memory result.
      console.error(
        `[ai voice] message ${messageId} transcript write failed: ${error.message ?? 'unknown error'}`
      );
    }
  };

  const finish = async (
    outcome: TranscriptOutcome
  ): Promise<TranscriptOutcome> => {
    try {
      await persist(outcome);
    } catch (err) {
      console.error(
        `[ai voice] message ${messageId} transcript write threw: ${err instanceof Error ? err.name : 'unknown'}`
      );
    }
    log(outcome);
    return outcome;
  };

  try {
    const { data, error } = await db
      .from('messages')
      .select(
        'content_type, sender_type, media_url, media_type, transcript, transcript_status'
      )
      .eq('id', messageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    const row = data as MessageRow | null;
    if (
      error ||
      !row ||
      row.content_type !== 'audio' ||
      row.sender_type !== 'customer'
    ) {
      const outcome: TranscriptOutcome = {
        status: 'failed',
        reason: 'download_failed',
      };
      log(outcome);
      return outcome;
    }

    // R8: one transcription per message.
    if (row.transcript_status === 'done') {
      return row.transcript
        ? { status: 'done', text: row.transcript }
        : { status: 'failed', reason: 'previous_attempt' };
    }
    if (
      row.transcript_status === 'failed' ||
      row.transcript_status === 'skipped'
    ) {
      return { status: row.transcript_status, reason: 'previous_attempt' };
    }

    const transcriber = resolveTranscriber(config);
    if (!transcriber) {
      return finish({ status: 'skipped', reason: 'no_transcriber' });
    }

    const audio = await loadAudio({
      accountId,
      mediaUrl: row.media_url,
      mediaType: row.media_type,
      source,
      storage: db.storage as unknown as VoiceNoteStorage,
      maxBytes: aiVoiceMaxBytes(),
    });
    if (!audio.ok) {
      return finish({ status: audio.status, reason: audio.reason });
    }

    const mimeType = audio.mimeType;
    if (!mimeType || !TRANSCRIBE_MIME[transcriber.provider].has(mimeType)) {
      return finish({ status: 'skipped', reason: 'unsupported_format' });
    }

    if (mimeType === 'audio/ogg') {
      const seconds = oggOpusDurationSeconds(audio.bytes);
      if (seconds !== null && seconds > aiVoiceMaxSeconds()) {
        return finish({ status: 'skipped', reason: 'too_long' });
      }
    }

    const call = () => {
      attempts += 1;
      return transcribe({
        transcriber,
        bytes: audio.bytes,
        mimeType,
        timeoutMs: aiTranscribeTimeoutMs(),
      });
    };

    let result: ProviderResult;
    try {
      try {
        result = await call();
      } catch (err) {
        if (!isTransientTranscribeError(err)) throw err;
        await sleep(TRANSCRIBE_RETRY_DELAY_MS);
        result = await call();
      }
    } catch (err) {
      return finish({ status: 'failed', reason: reasonFor(err) });
    }

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'transcription',
      provider: transcriber.provider,
      model: transcriber.model,
      keySource: transcriber.keySource,
      usage: result.usage,
    });

    const text = cleanTranscript(result.text ?? '');
    if (!text) return finish({ status: 'failed', reason: 'empty' });
    return finish({ status: 'done', text });
  } catch (err) {
    // R30: anything unexpected ends as failed, never as a throw.
    console.error(
      `[ai voice] message ${messageId} transcription crashed: ${err instanceof Error ? err.name : 'unknown'}`
    );
    const outcome: TranscriptOutcome = {
      status: 'failed',
      reason: 'provider_error',
    };
    try {
      await persist(outcome);
    } catch {
      // already logged above; nothing else to do
    }
    return outcome;
  }
}
