import { describe, expect, it } from 'vitest';

import {
  authHeader,
  buildIntegrationRequest,
  encodePathValue,
  validateCallParams,
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
