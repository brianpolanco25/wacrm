import { describe, expect, it } from 'vitest';

import {
  ApiError,
  IDEMPOTENT_REPLAYED_HEADER,
  REQUEST_ID_HEADER,
  badRequest,
  fail,
  ok,
  okList,
  rateLimited,
  replayed,
  toApiErrorResponse,
} from './respond';

// ---------------------------------------------------------------------------
// Fase 7 §1 — "every /api/v1 response carries `Cache-Control: no-store` and
// `X-Request-Id`, and the error envelope repeats it as `request_id`".
//
// The point of centralising it in respond.ts is that no route has to
// remember; these tests are what keeps that true when a constructor is
// added later.
// ---------------------------------------------------------------------------

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectEnvelopeHeaders(res: Response) {
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  const id = res.headers.get(REQUEST_ID_HEADER);
  expect(id).toMatch(UUID_V4);
  return id as string;
}

describe('v1 response envelope headers', () => {
  it('ok / okList carry no-store and a fresh uuid request id', () => {
    expectEnvelopeHeaders(ok({ hi: true }));
    expectEnvelopeHeaders(okList([], null));
    // Fresh per response: two calls never share an id.
    expect(expectEnvelopeHeaders(ok({}))).not.toBe(
      expectEnvelopeHeaders(ok({}))
    );
  });

  it('fail repeats the id inside the envelope as request_id', async () => {
    const res = fail('meta_error', 'Meta said no', 502);
    const headerId = expectEnvelopeHeaders(res);
    const body = (await res.json()) as {
      error: { code: string; message: string; request_id: string };
    };
    expect(res.status).toBe(502);
    expect(body.error.code).toBe('meta_error');
    expect(body.error.request_id).toBe(headerId);
  });

  it('toApiErrorResponse keeps code, status, extra headers and adds request_id', async () => {
    const res = toApiErrorResponse(badRequest("'to' is required"));
    const headerId = expectEnvelopeHeaders(res);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.request_id).toBe(headerId);

    // The rate-limit headers still ride along with the envelope ones.
    const limited = toApiErrorResponse(
      rateLimited({
        success: false,
        remaining: 0,
        reset: Date.now() + 30_000,
        limit: 120,
      })
    );
    expectEnvelopeHeaders(limited);
    expect(limited.headers.get('X-RateLimit-Limit')).toBe('120');
    expect(limited.headers.get('Retry-After')).toBeTruthy();
  });

  it('an unknown throwable collapses to 500 internal without leaking its text', async () => {
    const res = toApiErrorResponse(
      new Error('relation "contacts" does not exist at line 3')
    );
    const headerId = expectEnvelopeHeaders(res);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(res.status).toBe(500);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('relation');
    expect(body.error.request_id).toBe(headerId);
  });

  it('the new fase 7 codes keep their status through the envelope', async () => {
    for (const [code, status] of [
      ['conflict', 409],
      ['idempotency_mismatch', 409],
      ['payload_too_large', 413],
      ['unsupported_media_type', 415],
    ] as const) {
      const res = toApiErrorResponse(new ApiError(code, 'nope', status));
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(code);
    }
  });
});

describe('replayed', () => {
  it('reproduces body and status and flags itself with a fresh request id', async () => {
    const stored = { data: { message_id: 'm-1' } };
    const res = replayed(stored, 201);
    const id = expectEnvelopeHeaders(res);
    expect(res.status).toBe(201);
    expect(res.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    await expect(res.json()).resolves.toEqual(stored);
    // A replay is still a distinct request: its own correlation id.
    expect(replayed(stored, 201).headers.get(REQUEST_ID_HEADER)).not.toBe(id);
  });
});
