import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// p11.1 — ¿tiene el WABA un método de pago en Meta?
//
// Todo con `fetch` mockeado: ninguna prueba sale de la máquina. Lo que se
// fija aquí, en el orden de `requirements.md`:
//   R4  clasificación de la respuesta (una prueba por rama) y la petición
//   R5  permisos → unknown, una sola línea de console.warn
//   R6  el token no aparece ni en consola ni en la escritura
//   R9  barrido con reloj inyectado: qué filas entran y el límite
//   R10 una fila que falla no para a las demás
//   R12 fila de otra cuenta: null, sin fetch ni UPDATE
//   R13 interruptor META_PAYMENT_CHECK_DISABLED
//   R15–R18, R23 metaBillingOf / metaPaymentBanner
//   CP3 cada escritura va con id + account_id
// ---------------------------------------------------------------------------

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => {
    if (!String(v).startsWith('enc:')) throw new Error('bad ciphertext');
    return String(v).replace(/^enc:/, '');
  },
}));

import {
  META_BILLING_HUB_URL,
  PAYMENT_RECHECK_MS,
  PAYMENT_SWEEP_LIMIT,
  checkAndRecordPaymentStatus,
  classifyFundingResponse,
  fetchWabaPaymentStatus,
  isPaymentCheckDisabled,
  metaBillingOf,
  metaPaymentBanner,
  recordPaymentStatus,
  sweepPaymentStatus,
} from './payment-method';

const TOKEN = 'EAAB-secret-token-do-not-log';
const NOW = new Date('2026-10-01T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function row(overrides: Row = {}): Row {
  return {
    id: 'cfg-a',
    account_id: 'acct-a',
    user_id: 'user-a',
    phone_number_id: 'pn-a',
    waba_id: 'waba-a',
    access_token: `enc:${TOKEN}`,
    status: 'connected',
    provisioned_via: 'embedded_signup',
    meta_payment_status: null,
    meta_payment_checked_at: null,
    meta_payment_error: null,
    ...overrides,
  };
}

function client(rows: Row[]): { db: FakeDatabase; supabase: SupabaseClient } {
  const db = new FakeDatabase({ whatsapp_config: rows });
  return { db, supabase: db.admin as unknown as SupabaseClient };
}

let fetchMock: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

function consoleText(): string {
  return JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls]);
}

// ---------------------------------------------------------------------------

describe('classifyFundingResponse (R4)', () => {
  it('primary_funding_id presente → ok', () => {
    expect(
      classifyFundingResponse('waba-a', {
        id: 'waba-a',
        primary_funding_id: '1234',
      })
    ).toBe('ok');
  });

  it.each([
    ['ausente', { id: 'waba-a' }],
    ['null', { id: 'waba-a', primary_funding_id: null }],
    ['cadena vacía', { id: 'waba-a', primary_funding_id: '' }],
  ])('2xx con el id pedido y funding %s → missing', (_label, body) => {
    expect(classifyFundingResponse('waba-a', body)).toBe('missing');
  });

  it.each([
    ['sin id', {}],
    ['con otro id', { id: 'waba-otro' }],
    ['null', null],
    ['un array', []],
    ['una cadena', 'ok'],
    ['funding de tipo raro', { id: 'waba-a', primary_funding_id: 42 }],
  ])('cualquier otra cosa (%s) → unknown', (_label, body) => {
    expect(classifyFundingResponse('waba-a', body)).toBe('unknown');
  });
});

describe('fetchWabaPaymentStatus (R4–R6)', () => {
  it('una sola llamada GET al nodo WABA con el token en Authorization', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: 'waba-a', primary_funding_id: 'f-1' })
    );
    const result = await fetchWabaPaymentStatus({
      wabaId: 'waba-a',
      accessToken: TOKEN,
    });
    expect(result).toEqual({ status: 'ok', error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://graph.facebook.com/v21.0/waba-a?fields=id,primary_funding_id'
    );
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`
    );
    // Timeout de 5 s: viaja una señal de aborto.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('2xx sin primary_funding_id → missing, sin error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'waba-a' }));
    expect(
      await fetchWabaPaymentStatus({ wabaId: 'waba-a', accessToken: TOKEN })
    ).toEqual({ status: 'missing', error: null });
  });

  it('2xx sin id → unknown (nunca missing)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const r = await fetchWabaPaymentStatus({
      wabaId: 'waba-a',
      accessToken: TOKEN,
    });
    expect(r.status).toBe('unknown');
  });

  it.each([10, 200, 100])(
    'error de permisos de Meta (code %s) → unknown con el mensaje y una sola línea de warn (R5)',
    async (code) => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, {
          error: {
            message: `(#${code}) Requires whatsapp_business_management permission`,
            code,
            type: 'OAuthException',
          },
        })
      );
      const r = await fetchWabaPaymentStatus({
        wabaId: 'waba-a',
        accessToken: TOKEN,
      });
      expect(r.status).toBe('unknown');
      expect(r.error).toContain('whatsapp_business_management');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('permission denied');
      expect(errorSpy).not.toHaveBeenCalled();
    }
  );

  it('HTTP 403 sin cuerpo JSON → unknown', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => {
        throw new SyntaxError('not json');
      },
    } as unknown as Response);
    const r = await fetchWabaPaymentStatus({
      wabaId: 'waba-a',
      accessToken: TOKEN,
    });
    expect(r).toEqual({ status: 'unknown', error: 'Meta API error: 403' });
  });

  it('error de red / timeout → unknown, no lanza', async () => {
    fetchMock.mockRejectedValue(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError'
      )
    );
    const r = await fetchWabaPaymentStatus({
      wabaId: 'waba-a',
      accessToken: TOKEN,
    });
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('timeout');
  });

  it('JSON inválido en un 2xx → unknown', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);
    const r = await fetchWabaPaymentStatus({
      wabaId: 'waba-a',
      accessToken: TOKEN,
    });
    expect(r.status).toBe('unknown');
  });

  it('trunca el mensaje a 500 caracteres y nunca escribe el token (R6)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: { message: 'x'.repeat(2000), code: 1 },
      })
    );
    const r = await fetchWabaPaymentStatus({
      wabaId: 'waba-a',
      accessToken: TOKEN,
    });
    expect(r.error).toHaveLength(500);
    expect(consoleText()).not.toContain(TOKEN);
    expect(consoleText()).not.toContain('graph.facebook.com');
  });
});

describe('recordPaymentStatus / checkAndRecordPaymentStatus', () => {
  it('escribe con id Y account_id, y ok/missing limpian el error (CP3)', async () => {
    const { db, supabase } = client([
      row({ meta_payment_status: 'unknown', meta_payment_error: 'old' }),
    ]);
    await recordPaymentStatus(
      supabase,
      { accountId: 'acct-a', configId: 'cfg-a' },
      { status: 'ok', error: 'ignored' },
      NOW
    );
    const update = db.log.find((q) => q.op === 'update');
    expect(update?.filters).toEqual(
      expect.arrayContaining([
        { column: 'id', op: 'eq', value: 'cfg-a' },
        { column: 'account_id', op: 'eq', value: 'acct-a' },
      ])
    );
    const saved = db.rows('whatsapp_config')[0];
    expect(saved.meta_payment_status).toBe('ok');
    expect(saved.meta_payment_checked_at).toBe(NOW.toISOString());
    expect(saved.meta_payment_error).toBeNull();
  });

  it('descifra el token de la fila, comprueba y guarda; el token no llega a BD ni consola (R6)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: { message: 'Invalid OAuth access token', code: 190 },
      })
    );
    const { db, supabase } = client([row()]);
    const result = await checkAndRecordPaymentStatus(
      supabase,
      { accountId: 'acct-a', configId: 'cfg-a' },
      { now: NOW }
    );
    expect(result).toEqual({
      status: 'unknown',
      error: 'Invalid OAuth access token',
      checkedAt: NOW.toISOString(),
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`
    );
    const saved = db.rows('whatsapp_config')[0];
    expect(saved.meta_payment_status).toBe('unknown');
    expect(saved.meta_payment_error).toBe('Invalid OAuth access token');
    const writes = JSON.stringify(
      db.log.filter((q) => q.op === 'update').map((q) => q.payload)
    );
    expect(writes).not.toContain(TOKEN);
    expect(consoleText()).not.toContain(TOKEN);
  });

  it('usa el token en claro que le pasan (alta / guardado manual) sin descifrar', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'waba-a' }));
    const { supabase } = client([row({ access_token: 'not-decryptable' })]);
    const result = await checkAndRecordPaymentStatus(
      supabase,
      { accountId: 'acct-a', configId: 'cfg-a' },
      { accessToken: 'fresh-token', now: NOW }
    );
    expect(result?.status).toBe('missing');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer fresh-token'
    );
  });

  it('un token ilegible es unknown, sin llamar a Meta', async () => {
    const { db, supabase } = client([row({ access_token: 'garbage' })]);
    const result = await checkAndRecordPaymentStatus(
      supabase,
      { accountId: 'acct-a', configId: 'cfg-a' },
      { now: NOW }
    );
    expect(result?.status).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.rows('whatsapp_config')[0].meta_payment_status).toBe('unknown');
  });

  it('fila de otra cuenta → null, sin fetch y sin UPDATE (R12, fuga A↔B)', async () => {
    const { db, supabase } = client([
      row({ id: 'cfg-b', account_id: 'acct-b' }),
    ]);
    const result = await checkAndRecordPaymentStatus(supabase, {
      accountId: 'acct-a',
      configId: 'cfg-b',
    });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.log.some((q) => q.op === 'update')).toBe(false);
    expect(db.rows('whatsapp_config')[0].meta_payment_status).toBeNull();
  });

  it('fila sin waba_id → null, sin fetch', async () => {
    const { supabase } = client([row({ waba_id: null })]);
    expect(
      await checkAndRecordPaymentStatus(supabase, {
        accountId: 'acct-a',
        configId: 'cfg-a',
      })
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con el interruptor puesto no lee ni llama a Meta (R13)', async () => {
    vi.stubEnv('META_PAYMENT_CHECK_DISABLED', '1');
    const { db, supabase } = client([row()]);
    expect(
      await checkAndRecordPaymentStatus(
        supabase,
        { accountId: 'acct-a', configId: 'cfg-a' },
        { accessToken: 'x' }
      )
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.log).toHaveLength(0);
  });
});

describe('isPaymentCheckDisabled (R13)', () => {
  it('solo "1" apaga', () => {
    vi.stubEnv('META_PAYMENT_CHECK_DISABLED', '');
    expect(isPaymentCheckDisabled()).toBe(false);
    vi.stubEnv('META_PAYMENT_CHECK_DISABLED', '0');
    expect(isPaymentCheckDisabled()).toBe(false);
    vi.stubEnv('META_PAYMENT_CHECK_DISABLED', '1');
    expect(isPaymentCheckDisabled()).toBe(true);
    vi.stubEnv('META_PAYMENT_CHECK_DISABLED', ' 1\n');
    expect(isPaymentCheckDisabled()).toBe(true);
  });
});

describe('sweepPaymentStatus (R9, R10, R13)', () => {
  function sweep(supabase: SupabaseClient, check = vi.fn()) {
    return sweepPaymentStatus(supabase, {
      now: () => NOW,
      check: check as never,
    });
  }

  it('elige solo los vencidos según su último estado', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'ok', error: null });
    const { supabase } = client([
      row({ id: 'never' }),
      row({
        id: 'missing-59',
        meta_payment_status: 'missing',
        meta_payment_checked_at: ago(59 * MIN),
      }),
      row({
        id: 'missing-61',
        meta_payment_status: 'missing',
        meta_payment_checked_at: ago(61 * MIN),
      }),
      row({
        id: 'unknown-5h',
        meta_payment_status: 'unknown',
        meta_payment_checked_at: ago(5 * HOUR),
      }),
      row({
        id: 'unknown-6h',
        meta_payment_status: 'unknown',
        meta_payment_checked_at: ago(6 * HOUR),
      }),
      row({
        id: 'ok-23h',
        meta_payment_status: 'ok',
        meta_payment_checked_at: ago(23 * HOUR),
      }),
      row({
        id: 'ok-24h',
        meta_payment_status: 'ok',
        meta_payment_checked_at: ago(24 * HOUR),
      }),
      row({ id: 'disconnected', status: 'disconnected' }),
      row({ id: 'no-waba', waba_id: null }),
    ]);

    const result = await sweep(supabase, check);

    const checkedWabas = check.mock.calls.length;
    expect(checkedWabas).toBe(4);
    expect(result).toEqual({
      enabled: true,
      scanned: 4,
      checked: 4,
      ok: 4,
      missing: 0,
      unknown: 0,
    });
  });

  it('las cadencias son 1 h / 6 h / 24 h', () => {
    expect(PAYMENT_RECHECK_MS).toEqual({
      missing: HOUR,
      unknown: 6 * HOUR,
      ok: 24 * HOUR,
    });
  });

  it('como mucho 25 por pasada', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'missing', error: null });
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ id: `cfg-${i}`, phone_number_id: `pn-${i}` })
    );
    const { supabase } = client(rows);
    const result = await sweep(supabase, check);
    expect(PAYMENT_SWEEP_LIMIT).toBe(25);
    expect(result.scanned).toBe(25);
    expect(result.checked).toBe(25);
    expect(result.missing).toBe(25);
    expect(check).toHaveBeenCalledTimes(25);
  });

  it('cada escritura lleva el id y el account_id de su fila (CP3)', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'ok', error: null });
    const { db, supabase } = client([
      row({ id: 'cfg-a', account_id: 'acct-a' }),
      row({ id: 'cfg-b', account_id: 'acct-b', phone_number_id: 'pn-b' }),
    ]);
    await sweep(supabase, check);
    const updates = db.log.filter((q) => q.op === 'update');
    expect(updates).toHaveLength(2);
    for (const [id, acct] of [
      ['cfg-a', 'acct-a'],
      ['cfg-b', 'acct-b'],
    ]) {
      expect(
        updates.some(
          (u) =>
            u.filters.some((f) => f.column === 'id' && f.value === id) &&
            u.filters.some((f) => f.column === 'account_id' && f.value === acct)
        )
      ).toBe(true);
    }
  });

  it('la primera fila falla en Meta y la segunda sale ok (R10)', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'waba-2', primary_funding_id: 'f' })
      );
    const { db, supabase } = client([
      row({ id: 'cfg-1', waba_id: 'waba-1' }),
      row({ id: 'cfg-2', waba_id: 'waba-2', phone_number_id: 'pn-2' }),
    ]);
    const result = await sweepPaymentStatus(supabase, { now: () => NOW });
    expect(result).toMatchObject({ checked: 2, ok: 1, unknown: 1 });
    const byId = Object.fromEntries(
      db.rows('whatsapp_config').map((r) => [r.id, r.meta_payment_status])
    );
    expect(byId).toEqual({ 'cfg-1': 'unknown', 'cfg-2': 'ok' });
    expect(consoleText()).not.toContain(TOKEN);
  });

  it('un check que lanza no para el barrido (R10)', async () => {
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'ok', error: null });
    const { supabase } = client([
      row({ id: 'cfg-1' }),
      row({ id: 'cfg-2', phone_number_id: 'pn-2' }),
    ]);
    const result = await sweep(supabase, check);
    expect(result).toMatchObject({ checked: 2, ok: 1, unknown: 1 });
  });

  it('una lectura que falla devuelve el resultado vacío sin lanzar', async () => {
    const broken = {
      from: () => {
        throw new Error('connection refused');
      },
    } as unknown as SupabaseClient;
    await expect(sweepPaymentStatus(broken)).resolves.toEqual({
      enabled: true,
      scanned: 0,
      checked: 0,
      ok: 0,
      missing: 0,
      unknown: 0,
    });
  });

  it('con el interruptor puesto no consulta nada (R13)', async () => {
    vi.stubEnv('META_PAYMENT_CHECK_DISABLED', '1');
    const check = vi.fn();
    const { db, supabase } = client([row()]);
    const result = await sweep(supabase, check);
    expect(result.enabled).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(db.log).toHaveLength(0);
  });
});

describe('metaBillingOf (R18)', () => {
  it.each([
    [{}, 'direct'],
    [{ meta_billing: 'direct' }, 'direct'],
    [{ meta_billing: 'managed' }, 'managed'],
    [{ meta_billing: 'otra-cosa' }, 'direct'],
    [null, 'direct'],
  ] as const)('%j → %s', (input, expected) => {
    expect(metaBillingOf(input as Record<string, unknown> | null)).toBe(
      expected
    );
  });
});

describe('metaPaymentBanner (R15–R18, R23)', () => {
  const direct = {
    metaBilling: 'direct' as const,
    platformMode: true,
    disabled: false,
  };
  const n = (
    meta_payment_status: string | null,
    provisioned_via: string | null = 'embedded_signup',
    status = 'connected'
  ) => ({ status, provisioned_via, meta_payment_status });

  it('números missing → banner rojo con el contador (R15)', () => {
    expect(
      metaPaymentBanner([n('missing'), n('missing', 'manual'), n('ok')], direct)
    ).toEqual({ banner: 'missing', missingNumbers: 2 });
  });

  it('un número desconectado no cuenta', () => {
    expect(
      metaPaymentBanner(
        [n('missing', 'embedded_signup', 'disconnected')],
        direct
      )
    ).toEqual({ banner: null, missingNumbers: 0 });
  });

  it('todo ok o sin comprobar → nada (R16)', () => {
    expect(metaPaymentBanner([n('ok'), n('ok')], direct).banner).toBeNull();
    expect(metaPaymentBanner([n(null), n(null)], direct).banner).toBeNull();
    expect(metaPaymentBanner([], direct).banner).toBeNull();
  });

  it.each([
    [true, 'embedded_signup', 'unknown'],
    [true, 'manual', null],
    [false, 'embedded_signup', null],
    [false, 'manual', null],
  ] as const)(
    'unknown con plataforma=%s y alta %s → %s (R17)',
    (platformMode, via, expected) => {
      expect(
        metaPaymentBanner([n('unknown', via)], {
          ...direct,
          platformMode,
        }).banner
      ).toBe(expected);
    }
  );

  it('missing gana a unknown', () => {
    expect(metaPaymentBanner([n('unknown'), n('missing')], direct).banner).toBe(
      'missing'
    );
  });

  it('cuenta managed → nada, sea cual sea el estado (R18)', () => {
    expect(
      metaPaymentBanner([n('missing'), n('unknown')], {
        ...direct,
        metaBilling: 'managed',
      })
    ).toEqual({ banner: null, missingNumbers: 0 });
  });

  it('interruptor puesto → nada (R13)', () => {
    expect(
      metaPaymentBanner([n('missing')], { ...direct, disabled: true }).banner
    ).toBeNull();
  });

  it('no lee ni devuelve readOnly: el aviso no bloquea envíos (R23)', () => {
    const rows = [
      Object.defineProperty(n('missing'), 'readOnly', {
        get() {
          throw new Error('metaPaymentBanner must not read readOnly');
        },
      }),
    ];
    const out = metaPaymentBanner(rows, direct);
    expect(Object.keys(out).sort()).toEqual(['banner', 'missingNumbers']);
  });

  it('el enlace del Billing Hub es una constante https de business.facebook.com (S-M4)', () => {
    expect(META_BILLING_HUB_URL).toMatch(
      /^https:\/\/business\.facebook\.com\/billing_hub\//
    );
  });
});
