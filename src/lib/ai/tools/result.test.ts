import { describe, expect, it } from 'vitest';

import type { IntegrationCallResult } from '@/lib/integrations/execute';
import type { OperationParam } from '@/lib/integrations/types';

import {
  annotateLocalDates,
  errorPayload,
  OUTCOME_HINTS,
  toolResultPayload,
} from './result';

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

describe('toolResultPayload — weekday of dates (n13.9)', () => {
  const SD = 'America/Santo_Domingo';
  const ok = (data: unknown) =>
    ({ ok: true, status: 200, data, latencyMs: 3 }) as IntegrationCallResult;

  it('adds <key>_local next to an ISO date, leaving the value intact', () => {
    const r = toolResultPayload(
      ok({ slots: [{ starts_at: '2026-11-13T14:00:00-04:00', doctor: 'A' }] }),
      declared,
      {},
      SD
    );
    expect(r.payload).toEqual({
      ok: true,
      status: 200,
      data: {
        slots: [
          {
            starts_at: '2026-11-13T14:00:00-04:00',
            starts_at_local: 'Friday 2026-11-13 14:00 (-04:00)',
            doctor: 'A',
          },
        ],
      },
    });
  });

  it('uses the integration zone, crossing midnight', () => {
    const r = toolResultPayload(
      ok({ at: '2026-11-13T23:30:00-04:00' }),
      declared,
      {},
      'Europe/Madrid'
    );
    expect(r.payload.data).toEqual({
      at: '2026-11-13T23:30:00-04:00',
      at_local: 'Saturday 2026-11-14 04:30 (+01:00)',
    });
  });

  it('without a zone, uses the offset of the value (old call sites)', () => {
    const r = toolResultPayload(
      ok({ at: '2026-11-13T23:30:00-04:00' }),
      declared,
      {}
    );
    expect(r.payload.data).toEqual({
      at: '2026-11-13T23:30:00-04:00',
      at_local: 'Friday 2026-11-13 23:30 (-04:00)',
    });
  });

  it('never overwrites an existing <key>_local', () => {
    const r = toolResultPayload(
      ok({ starts_at: '2026-11-13T14:00:00-04:00', starts_at_local: 'X' }),
      declared,
      {},
      SD
    );
    expect(r.payload.data).toEqual({
      starts_at: '2026-11-13T14:00:00-04:00',
      starts_at_local: 'X',
    });
  });

  it('walks nested arrays and objects; leaves non-ISO strings and the input alone', () => {
    const data = {
      days: [
        [{ starts_at: '2026-11-13T14:00:00-04:00' }],
        [{ slot: { ends_at: '2026-11-14T09:00:00-04:00' } }],
      ],
      date: '2026-11-13',
      note: 'viernes',
      list: ['2026-11-13T14:00:00-04:00'],
    };
    const before = JSON.stringify(data);
    const r = toolResultPayload(ok(data), declared, {}, SD);
    expect(r.payload.data).toEqual({
      days: [
        [
          {
            starts_at: '2026-11-13T14:00:00-04:00',
            starts_at_local: 'Friday 2026-11-13 14:00 (-04:00)',
          },
        ],
        [
          {
            slot: {
              ends_at: '2026-11-14T09:00:00-04:00',
              ends_at_local: 'Saturday 2026-11-14 09:00 (-04:00)',
            },
          },
        ],
      ],
      date: '2026-11-13',
      note: 'viernes',
      // A bare string in an array has no key: nothing to put next to it.
      list: ['2026-11-13T14:00:00-04:00'],
    });
    expect(JSON.stringify(data)).toBe(before);
  });

  it('stops at the depth cap', () => {
    let deep: Record<string, unknown> = { at: '2026-11-13T14:00:00-04:00' };
    for (let i = 0; i < 10; i++) deep = { n: deep };
    const out = JSON.stringify(annotateLocalDates(deep, SD));
    expect(out).not.toContain('at_local');
    expect(out).toContain('2026-11-13T14:00:00-04:00');
  });

  it('stops at the item cap', () => {
    const data = Array.from({ length: 2000 }, () => ({
      at: '2026-11-13T14:00:00-04:00',
    }));
    const out = annotateLocalDates(data, SD) as Record<string, unknown>[];
    expect(out).toHaveLength(2000);
    expect(out[0].at_local).toBe('Friday 2026-11-13 14:00 (-04:00)');
    expect(out[1999]).toEqual({ at: '2026-11-13T14:00:00-04:00' });
    const annotated = out.filter((o) => 'at_local' in o).length;
    expect(annotated).toBeGreaterThan(0);
    expect(annotated).toBeLessThanOrEqual(500);
  });

  it('annotates before truncating, and still fits in 8192 bytes', () => {
    const data = Array.from({ length: 300 }, (_, i) => ({
      i,
      starts_at: '2026-11-13T14:00:00-04:00',
    }));
    const r = toolResultPayload(ok(data), declared, {}, SD);
    expect(r.payload).toMatchObject({ ok: true, status: 200, truncated: true });
    expect(bytes(r.payload)).toBeLessThanOrEqual(8192);
    const text = r.payload.data_text as string;
    expect(text).toContain(
      '"starts_at":"2026-11-13T14:00:00-04:00","starts_at_local":"Friday 2026-11-13 14:00 (-04:00)"'
    );
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

  it('carries the remote error of the executor (remoteError), cut to 300', () => {
    const long = 'm'.repeat(500);
    const viaRemote = toolResultPayload(
      fail('http_error', 409, {
        remoteError: {
          code: 'slot_taken',
          message: long,
          field: 'starts_at',
          requestId: 'req-1',
        },
      }),
      declared,
      {}
    );
    expect(viaRemote.payload.error).toEqual({
      code: 'slot_taken',
      message: 'm'.repeat(300),
    });
    const noMessage = toolResultPayload(
      fail('http_error', 422, {
        remoteError: {
          code: 'bad',
          message: null,
          field: null,
          requestId: null,
        },
      }),
      declared,
      {}
    );
    expect(noMessage.payload.error).toEqual({ code: 'bad' });
    const none = toolResultPayload(fail('http_error', 422), declared, {});
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

describe('toolResultPayload — relative day of dates (n13.11)', () => {
  const SD = 'America/Santo_Domingo';
  // Jueves 12 de noviembre de 2026, 15:00 en Santo Domingo.
  const NOW = new Date('2026-11-12T15:00:00-04:00');
  const ok = (data: unknown) =>
    ({ ok: true, status: 200, data, latencyMs: 3 }) as IntegrationCallResult;
  const label = (at: string, now: Date | null = NOW, tz: string | null = SD) =>
    (
      toolResultPayload(ok({ at }), declared, {}, tz, now ?? undefined).payload
        .data as {
        at_local?: string;
      }
    ).at_local;

  it('(today)', () => {
    expect(label('2026-11-12T17:00:00-04:00')).toBe(
      'Thursday 2026-11-12 (today) 17:00 (-04:00)'
    );
  });

  it('(tomorrow)', () => {
    expect(label('2026-11-13T14:00:00-04:00')).toBe(
      'Friday 2026-11-13 (tomorrow) 14:00 (-04:00)'
    );
  });

  it('(in 5 days) and up to 30', () => {
    expect(label('2026-11-17T09:00:00-04:00')).toBe(
      'Tuesday 2026-11-17 (in 5 days) 09:00 (-04:00)'
    );
    expect(label('2026-12-12T09:00:00-04:00')).toBe(
      'Saturday 2026-12-12 (in 30 days) 09:00 (-04:00)'
    );
    expect(label('2026-12-13T09:00:00-04:00')).toBe(
      'Sunday 2026-12-13 09:00 (-04:00)'
    );
  });

  it('a past date has no relative label', () => {
    expect(label('2026-11-11T09:00:00-04:00')).toBe(
      'Wednesday 2026-11-11 09:00 (-04:00)'
    );
  });

  it('without now there is no relative label (old call sites)', () => {
    expect(label('2026-11-13T14:00:00-04:00', null)).toBe(
      'Friday 2026-11-13 14:00 (-04:00)'
    );
  });

  it('counts calendar days in the zone, not UTC: 21:30 in Santo Domingo is still today', () => {
    // 21:30 -04:00 = 01:30Z del viernes 13: en UTC ya es «Friday».
    const late = new Date('2026-11-12T21:30:00-04:00');
    expect(late.toISOString()).toBe('2026-11-13T01:30:00.000Z');
    expect(label('2026-11-12T22:00:00-04:00', late)).toBe(
      'Thursday 2026-11-12 (today) 22:00 (-04:00)'
    );
    expect(label('2026-11-13T08:00:00-04:00', late)).toBe(
      'Friday 2026-11-13 (tomorrow) 08:00 (-04:00)'
    );
  });

  it('without a zone, today is the one at the offset of the value', () => {
    const late = new Date('2026-11-12T21:30:00-04:00');
    expect(label('2026-11-13T08:00:00-04:00', late, null)).toBe(
      'Friday 2026-11-13 (tomorrow) 08:00 (-04:00)'
    );
  });

  it('annotateLocalDates takes now too', () => {
    expect(
      annotateLocalDates({ at: '2026-11-13T14:00:00-04:00' }, SD, NOW)
    ).toEqual({
      at: '2026-11-13T14:00:00-04:00',
      at_local: 'Friday 2026-11-13 (tomorrow) 14:00 (-04:00)',
    });
  });
});
