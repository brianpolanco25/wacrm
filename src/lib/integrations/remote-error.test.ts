import { describe, expect, it } from 'vitest';

import { parseRemoteError } from './remote-error';

// n13.5 (R19): forma de error de Cabbity Health, saneada.

const health = (error: Record<string, unknown>) => JSON.stringify({ error });

describe('parseRemoteError', () => {
  it('reads the full Health shape and drops details', () => {
    expect(
      parseRemoteError(
        health({
          code: 'validation_failed',
          message: 'El rango no puede pasar de 13 días.',
          field: 'to',
          details: { secret: 'x', nested: { deep: true } },
          request_id: 'req_abc',
        })
      )
    ).toEqual({
      code: 'validation_failed',
      message: 'El rango no puede pasar de 13 días.',
      field: 'to',
      requestId: 'req_abc',
    });
  });

  it('nulls the optional pieces when absent or not strings', () => {
    expect(
      parseRemoteError(health({ code: 'internal', field: 3, request_id: null }))
    ).toEqual({
      code: 'internal',
      message: null,
      field: null,
      requestId: null,
    });
  });

  it.each([
    ['missing code', { message: 'x' }],
    ['numeric code', { code: 42 }],
    ['empty code', { code: '' }],
    ['code with spaces', { code: 'bad code' }],
    ['code too long', { code: 'a'.repeat(65) }],
    ['code with markup', { code: '<b>x</b>' }],
  ])('%s → null', (_label, error) => {
    expect(parseRemoteError(health(error))).toBeNull();
  });

  it.each([
    ['broken JSON', '{"error":'],
    ['not an object', '"error"'],
    ['error as text', '{"error":"boom"}'],
    ['error as array', '{"error":[1]}'],
    ['array', '[1]'],
    ['empty', ''],
  ])('%s → null', (_label, text) => {
    expect(parseRemoteError(text)).toBeNull();
  });

  it('strips control characters and cuts the message to 300', () => {
    const r = parseRemoteError(
      health({ code: 'x', message: `a\u0000b\nc\u001b${'z'.repeat(400)}` })
    );
    expect(r?.message).toBe(`abc${'z'.repeat(297)}`);
    expect(r?.message).toHaveLength(300);
  });

  it('a field or request id over 100 characters becomes null', () => {
    const r = parseRemoteError(
      health({ code: 'x', field: 'f'.repeat(101), request_id: 'r'.repeat(101) })
    );
    expect(r).toMatchObject({ field: null, requestId: null });
  });
});
