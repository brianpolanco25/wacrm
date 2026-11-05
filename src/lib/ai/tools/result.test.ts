import { describe, expect, it } from 'vitest';

import type { IntegrationCallResult } from '@/lib/integrations/execute';
import type { OperationParam } from '@/lib/integrations/types';

import { errorPayload, OUTCOME_HINTS, toolResultPayload } from './result';

// n13.3 R17, R18, R21, R23, R24: lo que ve el modelo.

const bytes = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v)).length;

const declared: OperationParam[] = [
  {
    name: 'doctorId',
    in: 'path',
    type: 'integer',
    required: true,
    description: 'Doctor',
  },
];

function fail(
  outcome: string,
  status: number | null,
  extra: Record<string, unknown> = {}
): IntegrationCallResult {
  return {
    ok: false,
    outcome,
    status,
    latencyMs: 5,
    ...extra,
  } as IntegrationCallResult;
}

describe('toolResultPayload — success (R23)', () => {
  it('passes data through under 8192 bytes', () => {
    const r = toolResultPayload(
      { ok: true, status: 200, data: { id: 7 }, latencyMs: 3 },
      declared,
      {}
    );
    expect(r).toEqual({
      isError: false,
      payload: { ok: true, status: 200, data: { id: 7 } },
    });
  });

  it('truncates over 8192 bytes without splitting a character', () => {
    // Accents, emoji (surrogate pairs) and quotes that JSON escapes.
    const data = Array.from({ length: 2000 }, (_, i) => ({
      i,
      name: 'Pérez 😀 "x"',
    }));
    const r = toolResultPayload(
      { ok: true, status: 200, data, latencyMs: 3 },
      declared,
      {}
    );
    expect(r.isError).toBe(false);
    expect(r.payload).toMatchObject({ ok: true, status: 200, truncated: true });
    expect(r.payload).not.toHaveProperty('data');
    expect(bytes(r.payload)).toBeLessThanOrEqual(8192);
    expect(bytes(r.payload)).toBeGreaterThan(8000);
    const text = r.payload.data_text as string;
    expect(JSON.stringify(data).startsWith(text)).toBe(true);
    expect(text).not.toMatch(/[\ud800-\udbff]$/);
    expect(text).not.toContain('�');
  });
});

describe('toolResultPayload — failure (R24)', () => {
  it('invalid_params adds problem and param from the declared params', () => {
    const r = toolResultPayload(fail('invalid_params', null), declared, {});
    expect(r).toEqual({
      isError: true,
      payload: {
        ok: false,
        outcome: 'invalid_params',
        status: null,
        hint: OUTCOME_HINTS.invalid_params,
        problem: 'missing',
        param: 'doctorId',
      },
    });
    const typed = toolResultPayload(fail('invalid_params', null), declared, {
      doctorId: 'abc',
    });
    expect(typed.payload).toMatchObject({ problem: 'type', param: 'doctorId' });
  });

  it('http_error hints by status', () => {
    expect(
      toolResultPayload(fail('http_error', 404), declared, {}).payload.hint
    ).toBe('Not found: check the id.');
    expect(
      toolResultPayload(fail('http_error', 422), declared, {}).payload.hint
    ).toBe(OUTCOME_HINTS.http_error_conflict);
    expect(
      toolResultPayload(fail('http_error', 409), declared, {}).payload.hint
    ).toBe(OUTCOME_HINTS.http_error_conflict);
    expect(
      toolResultPayload(fail('http_error', 500), declared, {}).payload
    ).toEqual({
      ok: false,
      outcome: 'http_error',
      status: 500,
      hint: 'The service returned an error.',
    });
  });

  it.each([
    ['timeout'],
    ['unreachable'],
    ['rate_limited'],
    ['too_large'],
    ['blocked'],
    ['not_enabled'],
    ['error'],
  ])('%s has a fixed English hint', (outcome) => {
    const r = toolResultPayload(fail(outcome, null), declared, {});
    expect(r.isError).toBe(true);
    expect(r.payload.hint).toBe(OUTCOME_HINTS[outcome]);
  });

  it('reads an optional remote error (remoteError of n13.5 or error), cut to 300', () => {
    const long = 'm'.repeat(500);
    const viaRemote = toolResultPayload(
      fail('http_error', 409, {
        remoteError: { code: 'slot_taken', message: long, field: null },
      }),
      declared,
      {}
    );
    expect(viaRemote.payload.error).toEqual({
      code: 'slot_taken',
      message: 'm'.repeat(300),
    });
    const viaError = toolResultPayload(
      fail('http_error', 422, { error: { code: 42, message: 'bad date' } }),
      declared,
      {}
    );
    expect(viaError.payload.error).toEqual({ message: 'bad date' });
    const none = toolResultPayload(
      fail('http_error', 422, { remoteError: 'nope' }),
      declared,
      {}
    );
    expect(none.payload).not.toHaveProperty('error');
  });
});

describe('errorPayload (R17, R18, R21)', () => {
  it.each([
    'unknown_tool',
    'invalid_arguments',
    'limit_reached',
    'error',
  ] as const)('%s', (code) => {
    expect(errorPayload(code)).toEqual({
      isError: true,
      payload: {
        ok: false,
        outcome: code,
        status: null,
        hint: OUTCOME_HINTS[code],
      },
    });
  });
});
