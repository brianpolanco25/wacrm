import { describe, expect, it } from 'vitest';

import {
  authHeader,
  buildIntegrationRequest,
  callerParams,
  encodePathValue,
  validateCallParams,
  withAuthHeader,
} from './request';
import type { OperationParam } from './types';

const P = (p: Partial<OperationParam> & { name: string }): OperationParam => ({
  in: 'query',
  type: 'string',
  required: false,
  description: 'x',
  ...p,
});

describe('validateCallParams (R27)', () => {
  const declared = [
    P({ name: 'doctorId', in: 'path', type: 'integer', required: true }),
    P({ name: 'price', type: 'number' }),
    P({ name: 'urgent', in: 'body', type: 'boolean' }),
    P({ name: 'shift', enum: ['am', 'pm'] }),
    P({ name: 'note', in: 'body' }),
  ];

  it('coerces text from a flow into the declared types', () => {
    expect(
      validateCallParams(declared, {
        doctorId: '42',
        price: '12.5',
        urgent: 'true',
        shift: 'pm',
        note: 7,
      })
    ).toEqual({
      ok: true,
      values: {
        doctorId: 42,
        price: 12.5,
        urgent: true,
        shift: 'pm',
        note: '7',
      },
    });
  });

  it('keeps native values and drops empty optionals', () => {
    expect(
      validateCallParams(declared, {
        doctorId: 7,
        urgent: false,
        price: null,
        note: '',
      })
    ).toEqual({ ok: true, values: { doctorId: 7, urgent: false } });
  });

  it.each([
    [{ doctorId: 1, extra: 'x' }, 'unknown', 'extra'],
    [{}, 'missing', 'doctorId'],
    [{ doctorId: '' }, 'missing', 'doctorId'],
    [{ doctorId: '4.2' }, 'type', 'doctorId'],
    [{ doctorId: 'abc' }, 'type', 'doctorId'],
    [{ doctorId: 1, price: 'cheap' }, 'type', 'price'],
    [{ doctorId: 1, price: Infinity }, 'type', 'price'],
    [{ doctorId: 1, urgent: 'yes' }, 'type', 'urgent'],
    [{ doctorId: 1, urgent: 1 }, 'type', 'urgent'],
    [{ doctorId: 1, shift: 'night' }, 'enum', 'shift'],
    [{ doctorId: 1, note: { a: 1 } }, 'type', 'note'],
    [{ doctorId: 1, note: 'x'.repeat(2001) }, 'too_long', 'note'],
  ])('%o → %s on %s', (given, problem, param) => {
    expect(validateCallParams(declared, given)).toEqual({
      ok: false,
      problem,
      param,
    });
  });
});

const INTEGRATION = { base_url: 'https://health.example.com/api/v1' };

describe('buildIntegrationRequest (R21, R29)', () => {
  it('builds path, ordered query, flat JSON body and fixed headers', () => {
    const op = {
      method: 'POST' as const,
      path: '/doctors/{doctorId}/appointments',
      params: [
        P({ name: 'doctorId', in: 'path', type: 'integer', required: true }),
        P({ name: 'zeta' }),
        P({ name: 'alpha' }),
        P({ name: 'starts_at', in: 'body' }),
        P({ name: 'urgent', in: 'body', type: 'boolean' }),
      ],
    };
    const r = buildIntegrationRequest(INTEGRATION, op, {
      doctorId: 42,
      alpha: 'a b',
      zeta: 'z',
      starts_at: '2026-11-04T10:00:00Z',
      urgent: false,
    });
    expect(r).toEqual({
      url: 'https://health.example.com/api/v1/doctors/42/appointments?zeta=z&alpha=a+b',
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Cabbity-CRM-Integrations/1',
        'Content-Type': 'application/json',
      },
      body: '{"starts_at":"2026-11-04T10:00:00Z","urgent":false}',
    });
  });

  it('sends no body and no Content-Type without body params', () => {
    const r = buildIntegrationRequest(
      INTEGRATION,
      { method: 'GET', path: '/doctors', params: [] },
      {}
    );
    expect(r).toEqual({
      url: 'https://health.example.com/api/v1/doctors',
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Cabbity-CRM-Integrations/1',
      },
      body: undefined,
    });
  });

  const byId = {
    method: 'GET' as const,
    path: '/doctors/{id}',
    params: [P({ name: 'id', in: 'path', required: true })],
  };

  it('encodes "../admin" inside the same origin and prefix', () => {
    const r = buildIntegrationRequest(INTEGRATION, byId, { id: '../admin' });
    expect('url' in r && r.url).toBe(
      'https://health.example.com/api/v1/doctors/%2E%2E%2Fadmin'
    );
    expect('url' in r && new URL(r.url).origin).toBe(
      'https://health.example.com'
    );
  });

  it('"@evil.com" does not change the host', () => {
    const r = buildIntegrationRequest(INTEGRATION, byId, { id: '@evil.com' });
    expect('url' in r && new URL(r.url).host).toBe('health.example.com');
    expect('url' in r && r.url).toBe(
      'https://health.example.com/api/v1/doctors/%40evil%2Ecom'
    );
  });

  it('a value that would be normalized as a dot segment is blocked', () => {
    // encodePathValue never yields a bare `..`, but if a future change
    // let one through the parser would rewrite the path: the request is
    // refused rather than sent somewhere else.
    expect(encodePathValue('..')).toBe('%2E%2E');
    expect(buildIntegrationRequest(INTEGRATION, byId, { id: '..' })).toEqual({
      blocked: true,
    });
  });

  it('is blocked when a path value is missing', () => {
    expect(buildIntegrationRequest(INTEGRATION, byId, {})).toEqual({
      blocked: true,
    });
  });

  it('keeps a base url with a port', () => {
    const r = buildIntegrationRequest(
      { base_url: 'https://x.example.com:8443' },
      { method: 'GET', path: '/', params: [] },
      {}
    );
    expect('url' in r && r.url).toBe('https://x.example.com:8443/');
  });
});

describe('parameters named like Object.prototype members', () => {
  const op = {
    method: 'POST' as const,
    path: '/x',
    params: [
      P({ name: 'constructor' }),
      P({ name: 'toString', in: 'body' }),
      P({ name: 'valueOf', in: 'body', type: 'integer' }),
    ],
  };

  it('omitted optionals send no query and no body', () => {
    const check = validateCallParams(op.params, {});
    expect(check).toEqual({ ok: true, values: {} });
    const r = buildIntegrationRequest(
      INTEGRATION,
      op,
      check.ok ? check.values : {}
    );
    expect(r).toEqual({
      url: 'https://health.example.com/api/v1/x',
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Cabbity-CRM-Integrations/1',
      },
      body: undefined,
    });
  });

  it('given ones travel as their own values', () => {
    const check = validateCallParams(op.params, {
      constructor: 'a',
      toString: 'b',
      valueOf: '3',
    });
    const r = buildIntegrationRequest(
      INTEGRATION,
      op,
      check.ok ? check.values : {}
    );
    expect('url' in r && r.url).toBe(
      'https://health.example.com/api/v1/x?constructor=a'
    );
    expect('url' in r && r.body).toBe('{"toString":"b","valueOf":3}');
  });

  it('a path placeholder named constructor without a value is blocked', () => {
    expect(
      buildIntegrationRequest(
        INTEGRATION,
        {
          method: 'GET',
          path: '/x/{constructor}',
          params: [P({ name: 'constructor', in: 'path', required: true })],
        },
        {}
      )
    ).toEqual({ blocked: true });
  });
});

describe('authHeader', () => {
  it('bearer and custom header', () => {
    expect(authHeader('bearer', null, 'tok')).toEqual([
      'Authorization',
      'Bearer tok',
    ]);
    expect(authHeader('header', 'X-Api-Key', 'tok')).toEqual([
      'X-Api-Key',
      'tok',
    ]);
  });
});

// ---- n13.5: cabeceras autogeneradas y cuerpos anidados ----

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const IK: OperationParam = {
  name: 'Idempotency-Key',
  in: 'header',
  type: 'string',
  required: true,
  auto: 'uuid',
  description: 'Clave de idempotencia',
};

const CREATE_PATIENT = {
  method: 'POST' as const,
  path: '/patients',
  params: [
    IK,
    P({ name: 'first_name', in: 'body', required: true }),
    P({ name: 'consent.accepted', in: 'body', type: 'boolean' }),
    P({ name: 'consent.accepted_at', in: 'body' }),
    P({ name: 'consent.reference', in: 'body' }),
  ],
};

describe('callerParams (n13.5, R10)', () => {
  it('hides the auto headers and keeps the rest in order', () => {
    expect(callerParams(CREATE_PATIENT.params).map((p) => p.name)).toEqual([
      'first_name',
      'consent.accepted',
      'consent.accepted_at',
      'consent.reference',
    ]);
  });
});

describe('validateCallParams with auto headers (n13.5, R10)', () => {
  it('Idempotency-Key from the caller is unknown', () => {
    expect(
      validateCallParams(CREATE_PATIENT.params, {
        first_name: 'Ana',
        'Idempotency-Key': 'mine',
      })
    ).toEqual({ ok: false, problem: 'unknown', param: 'Idempotency-Key' });
  });

  it('the auto header is never missing', () => {
    expect(
      validateCallParams(CREATE_PATIENT.params, { first_name: 'Ana' })
    ).toEqual({ ok: true, values: { first_name: 'Ana' } });
  });
});

describe('nested bodies (n13.5, R14, R15)', () => {
  const dotted = {
    first_name: 'Ana',
    'consent.accepted': 'true',
    'consent.accepted_at': '2026-11-05T10:00:00-04:00',
    'consent.reference': 'WhatsApp',
  };
  const nested = {
    first_name: 'Ana',
    consent: {
      accepted: true,
      accepted_at: '2026-11-05T10:00:00-04:00',
      reference: 'WhatsApp',
    },
  };

  it('builds {"consent":{…}} from dotted names', () => {
    const check = validateCallParams(CREATE_PATIENT.params, dotted);
    expect(check.ok).toBe(true);
    const r = buildIntegrationRequest(
      INTEGRATION,
      CREATE_PATIENT,
      check.ok ? check.values : {},
      { uuid: () => 'fixed' }
    );
    expect('body' in r && JSON.parse(r.body!)).toEqual({
      first_name: 'Ana',
      consent: {
        accepted: true,
        accepted_at: '2026-11-05T10:00:00-04:00',
        reference: 'WhatsApp',
      },
    });
  });

  it('an object input is the same as the dotted one', () => {
    expect(validateCallParams(CREATE_PATIENT.params, nested)).toEqual(
      validateCallParams(CREATE_PATIENT.params, dotted)
    );
  });

  it('the same leaf by both ways is unknown, with the dotted name', () => {
    expect(
      validateCallParams(CREATE_PATIENT.params, {
        ...nested,
        'consent.accepted': true,
      })
    ).toEqual({ ok: false, problem: 'unknown', param: 'consent.accepted' });
  });

  it('an unknown nested leaf is unknown', () => {
    expect(
      validateCallParams(CREATE_PATIENT.params, {
        first_name: 'Ana',
        consent: { other: 1 },
      })
    ).toEqual({ ok: false, problem: 'unknown', param: 'consent.other' });
  });

  it('omits the parent when none of its leaves travel', () => {
    const r = buildIntegrationRequest(
      INTEGRATION,
      CREATE_PATIENT,
      { first_name: 'Ana' },
      { uuid: () => 'fixed' }
    );
    expect('body' in r && r.body).toBe('{"first_name":"Ana"}');
  });

  it('constructor.x is an own property, nothing written to the prototype', () => {
    const r = buildIntegrationRequest(
      INTEGRATION,
      {
        method: 'POST',
        path: '/x',
        params: [P({ name: 'constructor.x', in: 'body' })],
      },
      { 'constructor.x': 'v' }
    );
    expect('body' in r && r.body).toBe('{"constructor":{"x":"v"}}');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).x).toBe(
      undefined
    );
  });
});

describe('auto uuid headers (n13.5, R11)', () => {
  it('uses the injected generator and ignores values[name]', () => {
    const r = buildIntegrationRequest(
      INTEGRATION,
      CREATE_PATIENT,
      { first_name: 'Ana', 'Idempotency-Key': 'from-caller' },
      { uuid: () => 'generated-1' }
    );
    expect('headers' in r && r.headers['Idempotency-Key']).toBe('generated-1');
    expect('url' in r && r.url).toBe(
      'https://health.example.com/api/v1/patients'
    );
    expect('body' in r && r.body).toBe('{"first_name":"Ana"}');
  });

  it('two calls without a generator carry two different UUID v4', () => {
    const a = buildIntegrationRequest(INTEGRATION, CREATE_PATIENT, {
      first_name: 'Ana',
    });
    const b = buildIntegrationRequest(INTEGRATION, CREATE_PATIENT, {
      first_name: 'Ana',
    });
    const ka = 'headers' in a ? a.headers['Idempotency-Key'] : '';
    const kb = 'headers' in b ? b.headers['Idempotency-Key'] : '';
    expect(ka).toMatch(UUID_V4);
    expect(kb).toMatch(UUID_V4);
    expect(ka).not.toBe(kb);
  });
});

describe('withAuthHeader (n13.5, R12)', () => {
  it('drops any header with the same name in another case', () => {
    expect(
      withAuthHeader(
        { Accept: 'application/json', 'x-api-key': 'forged' },
        'X-Api-Key',
        'cred'
      )
    ).toEqual({ Accept: 'application/json', 'X-Api-Key': 'cred' });
  });

  it('adds Authorization when nothing collides', () => {
    expect(
      withAuthHeader({ Accept: 'a' }, 'Authorization', 'Bearer t')
    ).toEqual({ Accept: 'a', Authorization: 'Bearer t' });
  });
});

// ---- n13.8 (A1): normalización declarativa por parámetro ----
describe('validateCallParams with normalize: compact (n13.8, A1)', () => {
  const declared = [
    P({
      name: 'document_number',
      in: 'body',
      required: true,
      normalize: 'compact',
    }),
    P({ name: 'note', in: 'body' }),
  ];
  const doc = (value: unknown) => {
    const r = validateCallParams(declared, { document_number: value });
    return r.ok ? r.values.document_number : r;
  };

  it.each([
    ['001-1234567-8', '00112345678'],
    ['001 1234567 8', '00112345678'],
    ['001.1234567.8', '00112345678'],
    [' 001‑1234567–8 ', '00112345678'],
    ['AB 123456', 'AB123456'],
    ['00112345678', '00112345678'],
  ])('%j → %j', (given, expected) => {
    expect(doc(given)).toBe(expected);
  });

  it('a parameter without normalize is not touched', () => {
    const r = validateCallParams(declared, {
      document_number: '1',
      note: '001-1234567-8 a las 10.30',
    });
    expect(r.ok && r.values.note).toBe('001-1234567-8 a las 10.30');
  });

  it('a value that is only separators counts as missing', () => {
    expect(doc(' - . ')).toEqual({
      ok: false,
      problem: 'missing',
      param: 'document_number',
    });
  });

  it('a number is coerced to text as before', () => {
    expect(doc(12345)).toBe('12345');
  });

  it('the cleaned value is what travels in the body', () => {
    const r = validateCallParams(declared, {
      document_number: '001-1234567-8',
    });
    if (!r.ok) throw new Error('expected ok');
    const built = buildIntegrationRequest(
      { base_url: 'https://health.example.com/api/v1' },
      { method: 'POST', path: '/patients/lookup', params: declared },
      r.values
    );
    if ('blocked' in built) throw new Error('blocked');
    expect(JSON.parse(built.body!)).toEqual({ document_number: '00112345678' });
  });
});
