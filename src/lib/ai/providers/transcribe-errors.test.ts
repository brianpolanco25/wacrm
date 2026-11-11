import { describe, expect, it } from 'vitest';
import { AiError } from '../types';
import {
  isTransientTranscribeError,
  TranscribeHttpError,
} from './transcribe-errors';

const http = (status: number, code = 'provider_error') =>
  new TranscribeHttpError(new AiError('x', { code, status: 502 }), status);

describe('isTransientTranscribeError (R19)', () => {
  it('is true for network_error, timeout and rate_limited', () => {
    for (const code of ['network_error', 'timeout', 'rate_limited']) {
      expect(isTransientTranscribeError(new AiError('x', { code }))).toBe(true);
    }
  });

  it('is true for HTTP 500, 503 and 429', () => {
    expect(isTransientTranscribeError(http(500))).toBe(true);
    expect(isTransientTranscribeError(http(503))).toBe(true);
    expect(isTransientTranscribeError(http(429, 'rate_limited'))).toBe(true);
  });

  it('is false for invalid_key and HTTP 400/401/413/415', () => {
    expect(
      isTransientTranscribeError(new AiError('x', { code: 'invalid_key' }))
    ).toBe(false);
    expect(isTransientTranscribeError(http(401, 'invalid_key'))).toBe(false);
    for (const s of [400, 413, 415]) {
      expect(isTransientTranscribeError(http(s))).toBe(false);
    }
  });

  it('is false for a generic Error or a non-error', () => {
    expect(isTransientTranscribeError(new Error('boom'))).toBe(false);
    expect(isTransientTranscribeError('boom')).toBe(false);
  });

  it('keeps message, code and status of the base error', () => {
    const e = http(503);
    expect(e).toBeInstanceOf(AiError);
    expect(e.code).toBe('provider_error');
    expect(e.status).toBe(502);
    expect(e.upstreamStatus).toBe(503);
  });
});
