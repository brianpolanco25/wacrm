import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acct-a' }),
}));

import { __resetServiceCapCache, fetchServiceCap } from './use-service-cap';

// p11.3 R8: a failed read is «no data» (null), never a state; and the
// cache is keyed by account.

const BODY = {
  metaBilling: 'direct',
  action: 'warn',
  freeTier: 1000,
  monthStart: '2026-10-01T00:00:00.000Z',
  resetsAt: '2026-11-01T00:00:00.000Z',
  numbers: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetServiceCapCache();
  fetchMock = vi.fn(
    async () => new Response(JSON.stringify(BODY), { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchServiceCap', () => {
  it('a 500 resolves to null and is not cached', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"Failed to load the service quota"}', {
        status: 500,
      })
    );
    expect(await fetchServiceCap('acct-a')).toBeNull();
    expect(await fetchServiceCap('acct-a')).toEqual(BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a network error resolves to null', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await fetchServiceCap('acct-a')).toBeNull();
  });

  it('caches per account and force skips the cache', async () => {
    await fetchServiceCap('acct-a');
    await fetchServiceCap('acct-a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchServiceCap('acct-b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await fetchServiceCap('acct-a', { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith('/api/whatsapp/service-cap', {
      cache: 'no-store',
    });
  });

  it('a slow request A cannot overwrite a forced request B that finished first', async () => {
    let releaseA!: (res: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseA = resolve;
          })
      )
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ ...BODY, action: 'pause_ai' }), {
            status: 200,
          })
      );

    const a = fetchServiceCap('acct-a');
    const b = fetchServiceCap('acct-a', { force: true });
    expect((await b)?.action).toBe('pause_ai');

    // A answers late, with the action from before the PATCH.
    releaseA(new Response(JSON.stringify(BODY), { status: 200 }));
    expect((await a)?.action).toBe('warn');

    // The cache stays with B: no third fetch, and B's action.
    expect((await fetchServiceCap('acct-a'))?.action).toBe('pause_ai');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
