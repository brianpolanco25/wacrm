import { describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES, readJsonBody } from './body';
import { ApiError, toApiErrorResponse } from './respond';

// ---------------------------------------------------------------------------
// Fase 7 §1 — the guards every /api/v1 write inherits.
//
// The two that carry weight are the ones a mock would never catch: a body
// bigger than the ceiling has to be refused WHILE it is being read (a
// `Content-Length` header is a claim, not a fact), and a write without
// `Content-Type: application/json` has to say 415 rather than limp on to a
// confusing 400.
// ---------------------------------------------------------------------------

function jsonRequest(body: string, contentType = 'application/json'): Request {
  return new Request('https://crm.test/api/v1/messages', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

/** A body with no `Content-Length` — the ceiling has to hold anyway. */
function streamedRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Request('https://crm.test/api/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    // Required by undici for a streaming request body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

async function codeOf(promise: Promise<unknown>): Promise<{
  status: number;
  code: string;
}> {
  try {
    await promise;
    throw new Error('expected readJsonBody to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const res = toApiErrorResponse(err);
    const payload = (await res.json()) as { error: { code: string } };
    return { status: res.status, code: payload.error.code };
  }
}

describe('readJsonBody', () => {
  it('parses a JSON object and keeps the raw bytes for hashing', async () => {
    const raw = JSON.stringify({ to: '+1415', text: 'hi' });
    const { data, raw: kept } = await readJsonBody(jsonRequest(raw));
    expect(data).toEqual({ to: '+1415', text: 'hi' });
    // The idempotency hash is over these exact bytes, so they must be
    // the ones that arrived, not a re-serialisation.
    expect(kept).toBe(raw);
  });

  it('accepts a charset parameter and an +json subtype', async () => {
    await expect(
      readJsonBody(jsonRequest('{"a":1}', 'application/json; charset=utf-8'))
    ).resolves.toMatchObject({ data: { a: 1 } });
    await expect(
      readJsonBody(jsonRequest('{"a":1}', 'application/merge-patch+json'))
    ).resolves.toMatchObject({ data: { a: 1 } });
  });

  it('refuses text/plain with 415 unsupported_media_type', async () => {
    expect(
      await codeOf(readJsonBody(jsonRequest('{"a":1}', 'text/plain')))
    ).toEqual({
      status: 415,
      code: 'unsupported_media_type',
    });
  });

  it('refuses a missing Content-Type with 415', async () => {
    const request = new Request('https://crm.test/api/v1/messages', {
      method: 'POST',
      body: '{"a":1}',
    });
    request.headers.delete('content-type');
    expect(await codeOf(readJsonBody(request))).toEqual({
      status: 415,
      code: 'unsupported_media_type',
    });
  });

  it('accepts a body of exactly 1 MiB', async () => {
    // `{"t":"…"}` — pad the value so the whole document is 1 048 576 bytes.
    const envelope = '{"t":""}';
    const filler = 'a'.repeat(MAX_BODY_BYTES - envelope.length);
    const raw = `{"t":"${filler}"}`;
    expect(Buffer.byteLength(raw, 'utf8')).toBe(MAX_BODY_BYTES);
    await expect(readJsonBody(jsonRequest(raw))).resolves.toBeTruthy();
  });

  it('refuses 1 MiB + 1 with 413 payload_too_large', async () => {
    const envelope = '{"t":""}';
    const filler = 'a'.repeat(MAX_BODY_BYTES - envelope.length + 1);
    const raw = `{"t":"${filler}"}`;
    expect(Buffer.byteLength(raw, 'utf8')).toBe(MAX_BODY_BYTES + 1);
    expect(await codeOf(readJsonBody(jsonRequest(raw)))).toEqual({
      status: 413,
      code: 'payload_too_large',
    });
  });

  it('refuses an oversized STREAMED body, with no Content-Length to go by', async () => {
    // 17 chunks of 64 KiB = 1 MiB + 64 KiB, arriving a piece at a time.
    const chunk = 'a'.repeat(64 * 1024);
    const request = streamedRequest(Array.from({ length: 17 }, () => chunk));
    expect(request.headers.get('content-length')).toBeNull();
    expect(await codeOf(readJsonBody(request))).toEqual({
      status: 413,
      code: 'payload_too_large',
    });
  });

  it('refuses malformed JSON, an array and an empty body with 400', async () => {
    expect(await codeOf(readJsonBody(jsonRequest('{oops')))).toEqual({
      status: 400,
      code: 'bad_request',
    });
    expect(await codeOf(readJsonBody(jsonRequest('[1,2]')))).toEqual({
      status: 400,
      code: 'bad_request',
    });
    expect(await codeOf(readJsonBody(jsonRequest('')))).toEqual({
      status: 400,
      code: 'bad_request',
    });
  });
});
