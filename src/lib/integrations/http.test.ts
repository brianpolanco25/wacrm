import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetRateLimitForTests } from '@/lib/rate-limit';

import { performIntegrationRequest } from './http';
import type { BuiltRequest } from './request';
import {
  INTEGRATION_MAX_RESPONSE_BYTES,
  INTEGRATION_TIMEOUT_MS,
} from './types';

const REQ: BuiltRequest = {
  url: 'https://health.example.com/api/v1/me',
  method: 'GET',
  headers: { Accept: 'application/json', Authorization: 'Bearer secret' },
  body: undefined,
};

const publicHost = async () => true;

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('performIntegrationRequest', () => {
  it('R22: a private resolution is blocked without calling fetch', async () => {
    const fetch = vi.fn();
    const r = await performIntegrationRequest('acc-a', REQ, {
      fetch,
      isDeliverable: async () => false,
    });
    expect(r.outcome).toBe('blocked');
    expect(r.status).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://[::ffff:127.0.0.1]/me',
    'https://[::ffff:169.254.169.254]/latest/meta-data',
    'https://[::ffff:7f00:1]/me',
    'https://[64:ff9b::a9fe:a9fe]/me',
    'https://127.0.0.1/me',
    'https://svc.internal/me',
  ])(
    'R22: the literal %s is blocked before fetch, even if the resolver says yes',
    async (url) => {
      const fetch = vi.fn();
      const r = await performIntegrationRequest(
        'acc-a',
        { ...REQ, url },
        { fetch, isDeliverable: async () => true }
      );
      expect(r.outcome).toBe('blocked');
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('R22: the real resolver refuses IPv4-mapped loopback too', async () => {
    const fetch = vi.fn();
    const r = await performIntegrationRequest(
      'acc-a',
      { ...REQ, url: 'https://[::ffff:127.0.0.1]/me' },
      { fetch }
    );
    expect(r.outcome).toBe('blocked');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('R23: a 302 to an internal host is an http_error, never followed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        })
    );
    const r = await performIntegrationRequest('acc-a', REQ, {
      fetch,
      isDeliverable: publicHost,
    });
    expect(r).toMatchObject({ outcome: 'http_error', status: 302, data: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      redirect: 'manual',
      method: 'GET',
    });
  });

  it('R24: aborts after INTEGRATION_TIMEOUT_MS and reports timeout', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    const pending = performIntegrationRequest('acc-a', REQ, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      isDeliverable: publicHost,
    });
    await vi.advanceTimersByTimeAsync(INTEGRATION_TIMEOUT_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).outcome).toBe('timeout');
  });

  it('R25: a large content-length is refused without reading the body', async () => {
    const cancel = vi.fn(async () => {});
    const getReader = vi.fn();
    const res = {
      status: 200,
      headers: new Headers({
        'content-length': String(INTEGRATION_MAX_RESPONSE_BYTES + 1),
        'content-type': 'application/json',
      }),
      body: { cancel, getReader },
    } as unknown as Response;
    const r = await performIntegrationRequest('acc-a', REQ, {
      fetch: async () => res,
      isDeliverable: publicHost,
    });
    expect(r.outcome).toBe('too_large');
    expect(cancel).toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
  });

  it('R25: a stream past 256 KiB (300 KiB+) without content-length is cut and cancelled', async () => {
    const cancel = vi.fn();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 300 KiB útiles y luego más: el lector tiene que cortar antes del final.
        if (sent >= 1024 * 1024) return controller.close();
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel,
    });
    const r = await performIntegrationRequest('acc-a', REQ, {
      fetch: async () => new Response(stream, { status: 200 }),
      isDeliverable: publicHost,
    });
    expect(r.outcome).toBe('too_large');
    expect(cancel).toHaveBeenCalled();
    // Dejó de leer en cuanto pasó el máximo.
    expect(sent).toBeLessThanOrEqual(
      INTEGRATION_MAX_RESPONSE_BYTES + 2 * 64 * 1024
    );
  });

  it('R26: the 61st call of an account in a minute is rate limited; another account is not', async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    for (let i = 0; i < 60; i++) {
      const r = await performIntegrationRequest('acc-a', REQ, {
        fetch,
        isDeliverable: publicHost,
      });
      expect(r.outcome).toBe('ok');
    }
    const limited = await performIntegrationRequest('acc-a', REQ, {
      fetch,
      isDeliverable: publicHost,
    });
    expect(limited.outcome).toBe('rate_limited');
    expect(fetch).toHaveBeenCalledTimes(60);
    const other = await performIntegrationRequest('acc-b', REQ, {
      fetch,
      isDeliverable: publicHost,
    });
    expect(other.outcome).toBe('ok');
  });

  it('parses JSON, returns text otherwise, and flags invalid JSON', async () => {
    const ok = await performIntegrationRequest('acc-a', REQ, {
      fetch: async () => json({ data: [{ id: 1 }] }),
      isDeliverable: publicHost,
    });
    expect(ok).toMatchObject({
      outcome: 'ok',
      status: 200,
      data: { data: [{ id: 1 }] },
    });

    const text = await performIntegrationRequest('acc-a', REQ, {
      fetch: async () =>
        new Response('pong', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      isDeliverable: publicHost,
    });
    expect(text).toMatchObject({ outcome: 'ok', data: 'pong' });

    const bad = await performIntegrationRequest('acc-a', REQ, {
      fetch: async () =>
        new Response('{oops', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      isDeliverable: publicHost,
    });
    expect(bad).toMatchObject({
      outcome: 'http_error',
      status: 200,
      data: null,
    });
  });

  it('a 500 is an http_error and the body is discarded', async () => {
    const r = await performIntegrationRequest('acc-a', REQ, {
      fetch: async () => json({ error: 'patient 123 secret' }, { status: 500 }),
      isDeliverable: publicHost,
    });
    expect(r).toEqual({
      outcome: 'http_error',
      status: 500,
      data: null,
      latencyMs: r.latencyMs,
    });
  });

  it('a network failure is unreachable', async () => {
    const r = await performIntegrationRequest('acc-a', REQ, {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      isDeliverable: publicHost,
    });
    expect(r.outcome).toBe('unreachable');
  });

  it('measures latency with the injected clock', async () => {
    let t = 1000;
    const r = await performIntegrationRequest('acc-a', REQ, {
      fetch: async () => {
        t += 250;
        return json({});
      },
      isDeliverable: publicHost,
      now: () => t,
    });
    expect(r.latencyMs).toBe(250);
  });
});
