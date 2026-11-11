import { describe, expect, it } from 'vitest';

// n13.7 R2–R5: plantillas de fecha y validación de lecturas en vivo.

import type { OperationParam } from '@/lib/integrations/types';

import {
  hasUnknownTemplate,
  localDateInZone,
  readStoredLiveReads,
  resolveLiveTemplates,
  validateLiveReads,
  type LiveReadOperation,
} from './live-templates';

const NOW = new Date('2026-11-10T03:30:00Z');

const p = (
  name: string,
  type: OperationParam['type'],
  required: boolean,
  extra: Partial<OperationParam> = {}
): OperationParam => ({
  name,
  in: 'query',
  type,
  required,
  description: '',
  ...extra,
});

const FIND: LiveReadOperation = {
  key: 'find_availability',
  method: 'GET',
  is_active: true,
  params: [
    p('location_id', 'integer', true),
    p('from', 'string', true),
    p('to', 'string', true),
    p('membership_id', 'integer', false),
    p('mode', 'string', false, { enum: ['fast', 'full'] }),
    {
      name: 'X-Request-Id',
      in: 'header',
      type: 'string',
      required: false,
      description: '',
      auto: 'uuid',
    },
  ],
};
const OPS: LiveReadOperation[] = [
  FIND,
  { key: 'old_read', method: 'GET', is_active: false, params: [] },
  { key: 'create_appointment', method: 'POST', is_active: true, params: [] },
];

const valid = {
  operation: 'find_availability',
  params: {
    location_id: 3,
    from: '{{today}}',
    to: '{{today+13d}}',
    membership_id: 12,
  },
};

const validate = (raw: unknown, tz: string | null = 'America/Santo_Domingo') =>
  validateLiveReads(raw, OPS, { now: NOW, timeZone: tz });

describe('localDateInZone / resolveLiveTemplates (R4)', () => {
  it('{{today}} uses the local date of the integration zone', () => {
    expect(
      resolveLiveTemplates('{{today}}', NOW, 'America/Santo_Domingo')
    ).toBe('2026-11-09');
  });

  it('without a zone (null) it is UTC', () => {
    expect(resolveLiveTemplates('{{today}}', NOW, null)).toBe('2026-11-10');
  });

  it('{{today+13d}} adds calendar days across the end of the month', () => {
    expect(
      resolveLiveTemplates(
        '{{today+13d}}',
        new Date('2026-10-25T12:00:00Z'),
        'America/Santo_Domingo'
      )
    ).toBe('2026-11-07');
  });

  it('adds calendar days across a DST change (America/New_York, 2026-11-01)', () => {
    // 2026-10-31 23:30 local (EDT); +1 día = 2026-11-01 aunque el día dure 25 h.
    const now = new Date('2026-11-01T03:30:00Z');
    expect(localDateInZone(now, 'America/New_York')).toBe('2026-10-31');
    expect(localDateInZone(now, 'America/New_York', 1)).toBe('2026-11-01');
    expect(localDateInZone(now, 'America/New_York', 2)).toBe('2026-11-02');
  });

  it('replaces a template embedded in a longer text', () => {
    expect(
      resolveLiveTemplates('desde {{today}} hasta {{ today+1d }}', NOW, null)
    ).toBe('desde 2026-11-10 hasta 2026-11-11');
  });
});

describe('hasUnknownTemplate (R3)', () => {
  it.each(['{{today}}', 'x {{today+1d}}', '{{today+60d}}', 'no template'])(
    'accepts %s',
    (v) => expect(hasUnknownTemplate(v)).toBe(false)
  );
  it.each([
    '{{today+0d}}',
    '{{today+61d}}',
    '{{now}}',
    '{{ today',
    'a }} b',
    '{{today+100d}}',
  ])('rejects %s', (v) => expect(hasUnknownTemplate(v)).toBe(true));
});

describe('validateLiveReads (R2, R3, R5)', () => {
  it('[] and null → []', () => {
    expect(validate([])).toEqual({ ok: true, value: [] });
    expect(validate(null)).toEqual({ ok: true, value: [] });
  });

  it('accepts a valid find_availability read and stores the templates unresolved', () => {
    expect(validate([valid])).toEqual({ ok: true, value: [valid] });
  });

  it('rejects a non-array', () => {
    expect(validate({ operation: 'find_availability' }).ok).toBe(false);
  });

  it('rejects 4 entries', () => {
    expect(validate([valid, valid, valid, valid]).ok).toBe(false);
  });

  it('rejects an entry without operation string', () => {
    expect(validate([{ params: {} }]).ok).toBe(false);
    expect(validate([{ operation: 3 }]).ok).toBe(false);
  });

  it.each(['missing_op', 'old_read', 'create_appointment'])(
    'rejects operation %s (unknown, inactive or not GET)',
    (operation) => expect(validate([{ operation, params: {} }]).ok).toBe(false)
  );

  it('rejects an undeclared parameter', () => {
    expect(
      validate([{ ...valid, params: { ...valid.params, other: 'x' } }]).ok
    ).toBe(false);
  });

  it('rejects the auto header (not a caller parameter)', () => {
    expect(
      validate([
        { ...valid, params: { ...valid.params, 'X-Request-Id': 'abc' } },
      ]).ok
    ).toBe(false);
  });

  it('rejects a missing required parameter', () => {
    const { location_id: _drop, ...rest } = valid.params;
    void _drop;
    expect(validate([{ ...valid, params: rest }]).ok).toBe(false);
  });

  it('rejects a wrong type', () => {
    expect(
      validate([{ ...valid, params: { ...valid.params, location_id: 'abc' } }])
        .ok
    ).toBe(false);
  });

  it('rejects an enum value outside the list', () => {
    expect(
      validate([{ ...valid, params: { ...valid.params, mode: 'slow' } }]).ok
    ).toBe(false);
  });

  it('rejects an object value', () => {
    expect(
      validate([{ ...valid, params: { ...valid.params, from: { a: 1 } } }]).ok
    ).toBe(false);
  });

  it.each(['{{now}}', '{{today+0d}}', '{{today+61d}}'])(
    'rejects the template %s',
    (from) =>
      expect(
        validate([{ ...valid, params: { ...valid.params, from } }]).ok
      ).toBe(false)
  );
});

describe('readStoredLiveReads (R15)', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(
      readStoredLiveReads([
        valid,
        'x',
        { operation: 1 },
        { operation: 'a', params: { k: { nested: true }, n: 1 } },
      ])
    ).toEqual([valid, { operation: 'a', params: { n: 1 } }]);
    expect(readStoredLiveReads('garbage')).toEqual([]);
    expect(readStoredLiveReads(null)).toEqual([]);
  });
});
