import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consoleEmailProvider,
  createHttpEmailProvider,
  EMAIL_SEND_TIMEOUT_MS,
  resolveEmailProvider,
} from './provider';

// p11.7, R4–R7. Sin red: todo `fetch` es un mock.

const KEY = 'sk_test_SUPER_SECRET_key_123';
const TO = 'owner-a@example.test';
const CFG = {
  url: 'https://mail.example.test/v1/send',
  apiKey: KEY,
  from: 'Cabbity CRM <facturacion@example.test>',
};
const MSG = {
  to: [TO, 'admin-a@example.test'],
  subject: 'Asunto de prueba',
  text: 'Cuerpo de prueba con datos',
  kind: 'statement_issued',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveEmailProvider (R4)', () => {
  it('no variables → no provider, not_configured', () => {
    expect(resolveEmailProvider({})).toEqual({
      provider: null,
      reason: 'not_configured',
    });
  });

  it('the three HTTP variables → the HTTP provider', () => {
    const r = resolveEmailProvider({
      EMAIL_API_URL: CFG.url,
      EMAIL_API_KEY: KEY,
      EMAIL_FROM: CFG.from,
    });
    expect(r.reason).toBeNull();
    expect(r.provider?.name).toBe('http');
  });

  it('the HTTP variables win over EMAIL_PROVIDER=console', () => {
    const r = resolveEmailProvider({
      EMAIL_API_URL: CFG.url,
      EMAIL_API_KEY: KEY,
      EMAIL_FROM: CFG.from,
      EMAIL_PROVIDER: 'console',
    });
    expect(r.provider?.name).toBe('http');
  });

  it('EMAIL_PROVIDER=console without the HTTP variables → console', () => {
    const r = resolveEmailProvider({ EMAIL_PROVIDER: 'console' });
    expect(r).toEqual({ provider: consoleEmailProvider, reason: null });
  });

  it('EMAIL_PROVIDER=console with the HTTP variables half set → console', () => {
    const r = resolveEmailProvider({
      EMAIL_PROVIDER: 'console',
      EMAIL_API_URL: CFG.url,
    });
    expect(r.provider?.name).toBe('console');
  });

  it.each([
    ['only the URL', { EMAIL_API_URL: CFG.url }],
    ['only the key', { EMAIL_API_KEY: KEY }],
    ['only the sender', { EMAIL_FROM: CFG.from }],
    ['no sender', { EMAIL_API_URL: CFG.url, EMAIL_API_KEY: KEY }],
    [
      'a blank key',
      { EMAIL_API_URL: CFG.url, EMAIL_API_KEY: '  ', EMAIL_FROM: CFG.from },
    ],
  ])('%s → no provider, misconfigured', (_label, env) => {
    expect(resolveEmailProvider(env)).toEqual({
      provider: null,
      reason: 'misconfigured',
    });
  });

  it('an unknown EMAIL_PROVIDER is not a provider', () => {
    expect(resolveEmailProvider({ EMAIL_PROVIDER: 'smtp' })).toEqual({
      provider: null,
      reason: 'not_configured',
    });
  });

  it('reads process.env when called, not at import', () => {
    vi.stubEnv('EMAIL_PROVIDER', 'console');
    expect(resolveEmailProvider().provider?.name).toBe('console');
    vi.unstubAllEnvs();
  });
});

describe('createHttpEmailProvider (R5)', () => {
  it('one POST with the bearer key, JSON content type, the body and a 10 s timeout; 202 → ok', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const p = createHttpEmailProvider(
      CFG,
      fetchMock as unknown as typeof fetch
    );
    await expect(p.send(MSG)).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(CFG.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: CFG.from,
      to: MSG.to,
      subject: MSG.subject,
      text: MSG.text,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(EMAIL_SEND_TIMEOUT_MS);
    expect(EMAIL_SEND_TIMEOUT_MS).toBe(10_000);
  });

  it('500 → error with the status, never throws', async () => {
    const fetchMock = vi.fn(
      async () => new Response(`bad key ${KEY} for ${TO}`, { status: 500 })
    );
    const p = createHttpEmailProvider(
      CFG,
      fetchMock as unknown as typeof fetch
    );
    await expect(p.send(MSG)).resolves.toEqual({
      ok: false,
      error: 'HTTP 500',
    });
  });

  it('a rejected fetch → error with the error name', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError(`fetch failed to ${CFG.url} with ${KEY}`);
    });
    const p = createHttpEmailProvider(
      CFG,
      fetchMock as unknown as typeof fetch
    );
    await expect(p.send(MSG)).resolves.toEqual({
      ok: false,
      error: 'TypeError',
    });
  });

  it('a timeout (AbortError) → error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const p = createHttpEmailProvider(
      CFG,
      fetchMock as unknown as typeof fetch
    );
    await expect(p.send(MSG)).resolves.toEqual({
      ok: false,
      error: 'AbortError',
    });
  });

  it.each(['http://ejemplo.com/send', 'ftp://mail.example.test', 'not a url'])(
    '%s → error without calling fetch',
    async (url) => {
      const fetchMock = vi.fn();
      const p = createHttpEmailProvider(
        { ...CFG, url },
        fetchMock as unknown as typeof fetch
      );
      await expect(p.send(MSG)).resolves.toEqual({
        ok: false,
        error: 'invalid EMAIL_API_URL',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(['http://localhost:8025/send', 'http://127.0.0.1:8025/send'])(
    '%s (a local relay) is allowed',
    async (url) => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      const p = createHttpEmailProvider(
        { ...CFG, url },
        fetchMock as unknown as typeof fetch
      );
      await expect(p.send(MSG)).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
});

describe('secrets (R6)', () => {
  it('neither the key nor an address reaches the error or the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {})
    );
    const failures = [
      vi.fn(async () => new Response(`${KEY} ${TO}`, { status: 401 })),
      vi.fn(async () => {
        const e = new Error(`${KEY} ${TO}`);
        e.name = 'Error';
        throw e;
      }),
    ];
    const errors: string[] = [];
    for (const f of failures) {
      const p = createHttpEmailProvider(CFG, f as unknown as typeof fetch);
      const r = await p.send(MSG);
      expect(r.ok).toBe(false);
      if (!r.ok) errors.push(r.error);
    }
    await consoleEmailProvider.send(MSG);
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String));
    for (const text of [...errors, ...logged]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(TO);
      expect(text).not.toContain(MSG.text);
      expect(text.length).toBeLessThanOrEqual(300);
    }
  });

  it('an absurdly long error name is cut to 300 characters', async () => {
    const f = vi.fn(async () => {
      const e = new Error('x');
      e.name = 'N'.repeat(1000);
      throw e;
    });
    const p = createHttpEmailProvider(CFG, f as unknown as typeof fetch);
    const r = await p.send(MSG);
    expect(r.ok === false && r.error.length).toBe(300);
  });
});

describe('consoleEmailProvider (R7)', () => {
  it('logs one info line with the kind, the recipient count and the subject, no addresses; counts as sent', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(consoleEmailProvider.send(MSG)).resolves.toEqual({ ok: true });
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toContain('statement_issued');
    expect(line).toContain('2 recipient');
    expect(line).toContain(MSG.subject);
    expect(line).not.toContain('@');
  });
});
