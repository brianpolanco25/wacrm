import { AiError } from '../types';

// ============================================================
// n15.1 (R19) — which transcription failures deserve the one retry.
// ============================================================

/**
 * An `AiError` from a non-2xx transcription response that keeps the
 * provider's real HTTP status. `AiError.status` flattens everything to
 * 401/502 for the draft route; the retry decision needs the original
 * (429 and 5xx are transient, the other 4xx are not). A subclass instead
 * of a new field on `AiError`, which chat, drafts, tools and the key test
 * all share.
 */
export class TranscribeHttpError extends AiError {
  readonly upstreamStatus: number;
  constructor(base: AiError, upstreamStatus: number) {
    super(base.message, { code: base.code, status: base.status });
    this.name = 'TranscribeHttpError';
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * True when a failed transcription call is worth exactly one retry:
 * network error, timeout, 429 or 5xx. Any other 4xx (an invalid key, a
 * rejected format, a too-large body) and anything that is not an
 * `AiError` would fail the same way again.
 */
export function isTransientTranscribeError(err: unknown): boolean {
  if (err instanceof TranscribeHttpError) {
    return err.upstreamStatus === 429 || err.upstreamStatus >= 500;
  }
  if (err instanceof AiError) {
    return (
      err.code === 'network_error' ||
      err.code === 'timeout' ||
      err.code === 'rate_limited'
    );
  }
  return false;
}
