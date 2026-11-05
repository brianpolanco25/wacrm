import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Entitlements } from '@/lib/billing/entitlements';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { FakeDatabase } from '@/lib/security/fake-supabase';
import { encrypt } from '@/lib/whatsapp/encryption';

import {
  executeIntegrationOperation,
  testIntegrationConnection,
} from './execute';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  HEALTH_ID,
  seedIntegrationTables,
} from './integrations.test-support';
import { INTEGRATION_TIMEOUT_MS } from './types';

const CRED_A = 'cred-a-SECRET-1234';
const CRED_B = 'cred-b-SECRET-9876';
const SENTINEL = 'PATIENT-SENTINEL-7781';

let db: FakeDatabase;
let fetchSpy: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

const withPlan = async () =>
  ({ features: ['integrations'] }) as unknown as Entitlements;
const withoutPlan = async () =>
  ({ features: ['api'] }) as unknown as Entitlements;

function deps(extra: Record<string, unknown> = {}) {
  return {
    fetch: fetchSpy as unknown as typeof fetch,
    isDeliverable: async () => true,
    entitlements: withPlan,
    ...extra,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const client = () => db.admin as unknown as SupabaseClient;
const calls = () =>
  db.rows('integration_calls').filter((r) => r.account_id === ACCOUNT_A);
const rowA = () =>
  db
    .rows('account_integrations')
    .find((r) => r.account_id === ACCOUNT_A && r.integration_id === HEALTH_ID)!;

function run(
  operationKey = 'list_doctors',
  params: Record<string, unknown> = {},
  d = deps()
) {
  return executeIntegrationOperation(
    client(),
    {
      accountId: ACCOUNT_A,
      integrationSlug: 'health',
      operationKey,
      params,
      source: 'flow',
    },
    d
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  const seed = seedIntegrationTables();
  // B activó primero, con su propia credencial.
  seed.account_integrations[0].credential = encrypt(CRED_B);
  seed.account_integrations.push({
    id: 'ai-a-health',
    account_id: ACCOUNT_A,
    integration_id: HEALTH_ID,
    is_enabled: true,
    credential: encrypt(CRED_A),
    credential_last4: '1234',
    enabled_by: null,
    enabled_at: '2026-11-02T10:00:00.000Z',
    last_tested_at: null,
    last_test_status: null,
  });
  db = new FakeDatabase(seed);
  fetchSpy = vi.fn(async () => json({ data: [{ id: 1, name: 'Dra. Ruiz' }] }));
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

function expectNoSecretsLeaked() {
  const consoleText = JSON.stringify([
    ...errorSpy.mock.calls,
    ...warnSpy.mock.calls,
    ...logSpy.mock.calls,
  ]);
  const recorded = JSON.stringify(db.rows('integration_calls'));
  for (const secret of [CRED_A, CRED_B, SENTINEL]) {
    expect(consoleText).not.toContain(secret);
    expect(recorded).not.toContain(secret);
  }
}

describe('executeIntegrationOperation', () => {
  it('success: JSON data, the credential of THIS account, one exact log row', async () => {
    const r = await run('list_doctors', { specialty: SENTINEL });
    expect(r).toMatchObject({
      ok: true,
      status: 200,
      data: { data: [{ id: 1 }] },
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      `https://health.example.com/api/v1/doctors?specialty=${SENTINEL}`
    );
    expect(init.headers.Authorization).toBe(`Bearer ${CRED_A}`);
    expect(init.redirect).toBe('manual');

    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toEqual({
      id: expect.any(String),
      created_at: expect.any(String),
      updated_at: expect.any(String),
      account_id: ACCOUNT_A,
      integration_id: HEALTH_ID,
      operation_key: 'list_doctors',
      source: 'flow',
      outcome: 'ok',
      status_code: 200,
      latency_ms: expect.any(Number),
    });
    expectNoSecretsLeaked();
  });

  it('success: plain text when the response is not JSON', async () => {
    fetchSpy.mockResolvedValue(
      new Response('pong', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );
    expect(await run()).toMatchObject({ ok: true, data: 'pong' });
  });

  it('a header auth scheme sends the credential in that header', async () => {
    const integ = db.rows('integrations').find((r) => r.id === HEALTH_ID)!;
    integ.auth_scheme = 'header';
    integ.auth_header_name = 'X-Api-Key';
    await run();
    expect(fetchSpy.mock.calls[0][1].headers['X-Api-Key']).toBe(CRED_A);
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('a 500 is http_error, recorded', async () => {
    fetchSpy.mockResolvedValue(json({ error: SENTINEL }, 500));
    const r = await run();
    expect(r).toEqual({
      ok: false,
      outcome: 'http_error',
      status: 500,
      latencyMs: expect.any(Number),
    });
    expect(calls()[0]).toMatchObject({
      outcome: 'http_error',
      status_code: 500,
    });
    expectNoSecretsLeaked();
  });

  describe('not_enabled (R30), without a request', () => {
    it('the integration is retired', async () => {
      db.rows('integrations').find((r) => r.id === HEALTH_ID)!.is_active =
        false;
      expect(await run()).toMatchObject({ ok: false, outcome: 'not_enabled' });
      expect(calls()[0]).toMatchObject({
        outcome: 'not_enabled',
        status_code: null,
      });
    });

    it('the account has not enabled it', async () => {
      Object.assign(rowA(), { is_enabled: false, credential: null });
      expect(await run()).toMatchObject({ ok: false, outcome: 'not_enabled' });
    });

    it('the operation is retired or unknown', async () => {
      expect(await run('old_op')).toMatchObject({
        ok: false,
        outcome: 'not_enabled',
      });
      expect(await run('nope')).toMatchObject({
        ok: false,
        outcome: 'not_enabled',
      });
    });

    it('the plan lacks the integrations feature', async () => {
      expect(
        await run('list_doctors', {}, deps({ entitlements: withoutPlan }))
      ).toMatchObject({
        ok: false,
        outcome: 'not_enabled',
      });
    });

    it('the slug does not exist: no log row', async () => {
      const r = await executeIntegrationOperation(
        client(),
        {
          accountId: ACCOUNT_A,
          integrationSlug: 'ghost',
          operationKey: 'x',
          params: {},
          source: 'ai',
        },
        deps()
      );
      expect(r).toMatchObject({ ok: false, outcome: 'not_enabled' });
      expect(db.rows('integration_calls')).toHaveLength(1); // solo la semilla de B
    });

    afterEach(() => {
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it('invalid params: no request, recorded', async () => {
    const r = await run('create_appointment', {
      doctorId: 'abc',
      starts_at: SENTINEL,
    });
    expect(r).toMatchObject({ ok: false, outcome: 'invalid_params' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls()[0]).toMatchObject({
      outcome: 'invalid_params',
      operation_key: 'create_appointment',
    });
    expectNoSecretsLeaked();
  });

  it('a private resolution is blocked and recorded', async () => {
    const r = await run(
      'list_doctors',
      {},
      deps({ isDeliverable: async () => false })
    );
    expect(r).toMatchObject({ ok: false, outcome: 'blocked' });
    expect(calls()[0]).toMatchObject({ outcome: 'blocked' });
  });

  it('a database exception becomes `error` and never throws', async () => {
    const broken = {
      from: (table: string) => {
        if (table === 'integration_operations')
          throw new Error(`boom ${CRED_A}`);
        return db.admin.from(table);
      },
    } as unknown as SupabaseClient;
    const r = await executeIntegrationOperation(
      broken,
      {
        accountId: ACCOUNT_A,
        integrationSlug: 'health',
        operationKey: 'list_doctors',
        params: {},
        source: 'flow',
      },
      deps()
    );
    expect(r).toMatchObject({ ok: false, outcome: 'error', status: null });
    expect(calls()[0]).toMatchObject({ outcome: 'error' });
    expectNoSecretsLeaked();
  });

  it('a failed log insert keeps the result and logs only the code', async () => {
    const flaky = {
      from: (table: string) =>
        table === 'integration_calls'
          ? {
              insert: async () => ({
                data: null,
                error: { code: '42P01', message: `row ${SENTINEL}` },
              }),
            }
          : db.admin.from(table),
    } as unknown as SupabaseClient;
    const r = await executeIntegrationOperation(
      flaky,
      {
        accountId: ACCOUNT_A,
        integrationSlug: 'health',
        operationKey: 'list_doctors',
        params: { specialty: SENTINEL },
        source: 'flow',
      },
      deps()
    );
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(errorSpy).toHaveBeenCalledWith(
      '[integrations] could not record the call:',
      '42P01'
    );
    expectNoSecretsLeaked();
  });

  it('records a row per outcome with the right shape', async () => {
    fetchSpy.mockResolvedValueOnce(json({}, 404));
    await run();
    await run('nope');
    await run('create_appointment', {});
    expect(
      calls().map((c) => [c.operation_key, c.outcome, c.status_code])
    ).toEqual([
      ['list_doctors', 'http_error', 404],
      ['nope', 'not_enabled', null],
      ['create_appointment', 'invalid_params', null],
    ]);
    for (const c of calls()) {
      expect(Object.keys(c).sort()).toEqual(
        [
          'account_id',
          'created_at',
          'id',
          'integration_id',
          'latency_ms',
          'operation_key',
          'outcome',
          'source',
          'status_code',
          'updated_at',
        ].sort()
      );
    }
  });
});

describe('testIntegrationConnection (R18)', () => {
  const test = (d: Record<string, unknown> = {}) =>
    testIntegrationConnection(client(), ACCOUNT_A, HEALTH_ID, {
      fetch: fetchSpy as unknown as typeof fetch,
      isDeliverable: async () => true,
      ...d,
    });

  it.each([
    [200, 'ok'],
    [204, 'ok'],
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [500, 'error'],
    [302, 'error'],
  ])('HTTP %i → %s', async (status, expected) => {
    fetchSpy.mockResolvedValue(new Response(null, { status }));
    const r = await test();
    expect(r).toMatchObject({ result: expected, status });
    expect(rowA()).toMatchObject({ last_test_status: expected });
    expect(rowA().last_tested_at).toEqual(expect.any(String));
  });

  it('GETs base_url + test_path with the credential of this account', async () => {
    await test();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://health.example.com/api/v1/me');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${CRED_A}`);
    expect(calls()[0]).toMatchObject({
      source: 'test',
      operation_key: null,
      outcome: 'ok',
    });
    // B's row untouched.
    const b = db
      .rows('account_integrations')
      .find((r) => r.id === 'ai-b-health')!;
    expect(b.last_test_status).toBeNull();
    expectNoSecretsLeaked();
  });

  it('timeout → unreachable', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_r, reject) =>
          init.signal!.addEventListener('abort', () =>
            reject(new Error('aborted'))
          )
        )
    );
    const pending = test();
    await vi.advanceTimersByTimeAsync(INTEGRATION_TIMEOUT_MS);
    expect(await pending).toMatchObject({ result: 'unreachable' });
    expect(calls()[0]).toMatchObject({ outcome: 'timeout' });
  });

  it('a private DNS answer → unreachable without a request', async () => {
    const r = await test({ isDeliverable: async () => false });
    expect(r).toMatchObject({ result: 'unreachable', status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls()[0]).toMatchObject({ outcome: 'blocked' });
  });

  it('null without an activation or for a retired integration', async () => {
    Object.assign(rowA(), { is_enabled: false, credential: null });
    expect(await test()).toBeNull();
    expect(
      await testIntegrationConnection(
        client(),
        ACCOUNT_B,
        '9a000000-0000-4000-8000-000000000003',
        {
          fetch: fetchSpy as unknown as typeof fetch,
        }
      )
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rate limited → { rateLimited: true }, no stored status', async () => {
    for (let i = 0; i < 60; i++) await test();
    rowA().last_test_status = null;
    expect(await test()).toEqual({ rateLimited: true });
    expect(rowA().last_test_status).toBeNull();
    expect(calls().at(-1)).toMatchObject({ outcome: 'rate_limited' });
  });
});

// ---- n13.5: cabeceras autogeneradas, credencial única, error remoto ----

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function addBookOperation(headerName = 'Idempotency-Key') {
  db.rows('integration_operations').push({
    id: '9b000000-0000-4000-8000-000000000099',
    integration_id: HEALTH_ID,
    key: 'book',
    name: 'Reservar',
    description: 'Reserva',
    method: 'POST',
    path: '/appointments',
    params: [
      {
        name: headerName,
        in: 'header',
        type: 'string',
        required: true,
        auto: 'uuid',
        description: 'Idempotencia',
      },
      {
        name: 'starts_at',
        in: 'body',
        type: 'string',
        required: true,
        description: 'Inicio',
      },
    ],
    outputs: [],
    response_description: null,
    is_active: true,
    sort_order: 9,
  });
}

const healthError = (code: string, message: string) => ({
  error: {
    code,
    message,
    field: null,
    details: { hint: SENTINEL },
    request_id: 'req_x',
  },
});

describe('executeIntegrationOperation: auto headers (n13.5, R10–R12)', () => {
  it('Idempotency-Key from the caller → invalid_params, no request', async () => {
    addBookOperation();
    const r = await run('book', {
      starts_at: '2026-11-12T10:30:00-04:00',
      'Idempotency-Key': 'mine',
    });
    expect(r).toMatchObject({ ok: false, outcome: 'invalid_params' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls()[0]).toMatchObject({
      outcome: 'invalid_params',
      operation_key: 'book',
    });
  });

  it('two executions carry two different UUID v4 keys', async () => {
    addBookOperation();
    await run('book', { starts_at: '2026-11-12T10:30:00-04:00' });
    await run('book', { starts_at: '2026-11-12T10:30:00-04:00' });
    const keys = fetchSpy.mock.calls.map(
      (c) => (c[1].headers as Record<string, string>)['Idempotency-Key']
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(UUID_V4);
    expect(keys[1]).toMatch(UUID_V4);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('the injected generator is used', async () => {
    addBookOperation();
    await run('book', { starts_at: 'x' }, deps({ uuid: () => 'fixed-key' }));
    expect(fetchSpy.mock.calls[0][1].headers['Idempotency-Key']).toBe(
      'fixed-key'
    );
  });

  it('a header named like the credential never travels twice', async () => {
    const integ = db.rows('integrations').find((r) => r.id === HEALTH_ID)!;
    integ.auth_scheme = 'header';
    integ.auth_header_name = 'X-Api-Key';
    addBookOperation('x-api-key');
    await run('book', { starts_at: 'x' }, deps({ uuid: () => 'forged' }));
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    const matching = Object.keys(headers).filter(
      (k) => k.toLowerCase() === 'x-api-key'
    );
    expect(matching).toEqual(['X-Api-Key']);
    expect(headers['X-Api-Key']).toBe(CRED_A);
  });
});

describe('executeIntegrationOperation: remote errors (n13.5, R20)', () => {
  it.each([
    [409, 'idempotency_mismatch', 'La misma clave con otro cuerpo.'],
    [422, 'validation_failed', 'El rango no puede pasar de 13 días.'],
    [401, 'api_key_expired', 'La clave venció.'],
    [401, 'api_key_revoked', 'La clave fue revocada.'],
    [429, 'rate_limited', 'Demasiadas peticiones.'],
  ])('HTTP %i %s → remoteError, the n13.1 row', async (status, code, msg) => {
    fetchSpy.mockResolvedValue(json(healthError(code, msg), status));
    const r = await run('list_doctors');
    expect(r).toEqual({
      ok: false,
      outcome: 'http_error',
      status,
      latencyMs: expect.any(Number),
      remoteError: { code, message: msg, field: null, requestId: 'req_x' },
    });
    expect(calls()).toHaveLength(1);
    expect(Object.keys(calls()[0]).sort()).toEqual(
      [
        'account_id',
        'created_at',
        'id',
        'integration_id',
        'latency_ms',
        'operation_key',
        'outcome',
        'source',
        'status_code',
        'updated_at',
      ].sort()
    );
    expect(calls()[0]).toMatchObject({
      outcome: 'http_error',
      status_code: status,
    });
    const recorded = JSON.stringify(db.rows('integration_calls'));
    expect(recorded).not.toContain(code);
    expect(recorded).not.toContain(msg);
    const consoleText = JSON.stringify([
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...logSpy.mock.calls,
    ]);
    expect(consoleText).not.toContain(msg);
    expectNoSecretsLeaked();
  });
});

describe('testIntegrationConnection with a Health 401 (n13.5, R21)', () => {
  it('api_key_revoked → auth_failed, same result shape', async () => {
    fetchSpy.mockResolvedValue(
      json(healthError('api_key_revoked', 'La clave fue revocada.'), 401)
    );
    const r = await testIntegrationConnection(client(), ACCOUNT_A, HEALTH_ID, {
      fetch: fetchSpy as unknown as typeof fetch,
      isDeliverable: async () => true,
    });
    expect(r).toEqual({
      result: 'auth_failed',
      status: 401,
      testedAt: expect.any(String),
    });
    expect(rowA()).toMatchObject({ last_test_status: 'auth_failed' });
  });
});
