import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSignedUrlCache,
  getSignedMediaUrl,
  MEDIA_SIGN_ENDPOINT,
  msUntilRefresh,
  SIGNED_URL_REFRESH_MARGIN_MS,
  SIGNED_URL_TTL_SECONDS,
  type SignedUrlClient,
} from './signed-url';

const ORIGIN = 'https://abc.supabase.co';
const OBJ = `${ORIGIN}/storage/v1/object/public/chat-media/account-a1/1-photo.png`;
const PROXY = '/api/whatsapp/media/123';
const EXTERNAL = 'https://cdn.example.com/x.png';

function fakeClient(opts: { fail?: boolean } = {}) {
  const calls: { bucket: string; path: string; expiresIn: number }[] = [];
  let n = 0;
  const client: SignedUrlClient = {
    storage: {
      from: (bucket) => ({
        createSignedUrl: async (path, expiresIn) => {
          calls.push({ bucket, path, expiresIn });
          if (opts.fail)
            return { data: null, error: { message: 'Object not found' } };
          n += 1;
          return {
            data: {
              signedUrl: `${ORIGIN}/storage/v1/object/sign/${bucket}/${path}?token=t${n}`,
            },
            error: null,
          };
        },
      }),
    },
  };
  return { client, calls };
}

beforeEach(() => {
  __resetSignedUrlCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('getSignedMediaUrl', () => {
  it('leaves the inbound proxy and external links untouched', async () => {
    const { client, calls } = fakeClient();
    expect(await getSignedMediaUrl(PROXY, { client })).toEqual({
      url: PROXY,
      expiresAt: null,
    });
    expect(await getSignedMediaUrl(EXTERNAL, { client })).toEqual({
      url: EXTERNAL,
      expiresAt: null,
    });
    expect(calls).toEqual([]);
  });

  it("signs a bucket object through the user's client for the short TTL", async () => {
    const { client, calls } = fakeClient();
    const now = () => 1_000_000;
    const out = await getSignedMediaUrl(OBJ, { client, now });

    expect(calls).toEqual([
      {
        bucket: 'chat-media',
        path: 'account-a1/1-photo.png',
        expiresIn: SIGNED_URL_TTL_SECONDS,
      },
    ]);
    expect(out.url).toMatch(
      /\/object\/sign\/chat-media\/account-a1\/1-photo\.png\?token=t1$/
    );
    expect(out.expiresAt).toBe(1_000_000 + SIGNED_URL_TTL_SECONDS * 1000);
    expect(SIGNED_URL_TTL_SECONDS).toBe(600);
  });

  it('caches the signed URL until it is about to expire, then re-signs', async () => {
    const { client, calls } = fakeClient();
    let clock = 0;
    const now = () => clock;

    const first = await getSignedMediaUrl(OBJ, { client, now });
    const again = await getSignedMediaUrl(OBJ, { client, now });
    expect(again.url).toBe(first.url);
    expect(calls).toHaveLength(1);

    // Inside the refresh margin: a fresh URL is minted.
    clock = SIGNED_URL_TTL_SECONDS * 1000 - SIGNED_URL_REFRESH_MARGIN_MS + 1;
    const renewed = await getSignedMediaUrl(OBJ, { client, now });
    expect(calls).toHaveLength(2);
    expect(renewed.url).not.toBe(first.url);
    expect(renewed.expiresAt).toBe(clock + SIGNED_URL_TTL_SECONDS * 1000);
  });

  it('de-duplicates concurrent requests for the same object', async () => {
    const { client, calls } = fakeClient();
    const [a, b] = await Promise.all([
      getSignedMediaUrl(OBJ, { client }),
      getSignedMediaUrl(OBJ, { client }),
    ]);
    expect(calls).toHaveLength(1);
    expect(a.url).toBe(b.url);
  });

  it('falls back to the stored URL when signing is refused, without caching the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = fakeClient({ fail: true });
    const out = await getSignedMediaUrl(OBJ, { client: refused.client });
    expect(out).toEqual({ url: OBJ, expiresAt: null });
    expect(warn).toHaveBeenCalled();

    // A later attempt with a working client signs — nothing was pinned.
    const ok = fakeClient();
    const next = await getSignedMediaUrl(OBJ, { client: ok.client });
    expect(next.url).toMatch(/token=t1$/);
  });

  it('accepts a lazy client factory', async () => {
    const { client, calls } = fakeClient();
    const out = await getSignedMediaUrl(OBJ, { client: async () => client });
    expect(calls).toHaveLength(1);
    expect(out.expiresAt).not.toBeNull();
  });
});

// m14.1 (A2): inside a support session the browser's own JWT is the
// operator's, which migration 044's policy maps to the operator's company,
// so signing goes through the server route instead.
describe('getSignedMediaUrl in a support session', () => {
  const SIGNED = `${ORIGIN}/storage/v1/object/sign/chat-media/account-a1/1-photo.png?token=srv`;

  function fakeFetch(
    reply: () => Response | Promise<Response> = () =>
      Response.json({
        url: SIGNED,
        expiresAt: 1_000_000 + 600_000,
        expiresIn: 600,
      })
  ) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return reply();
    }) as typeof fetch;
    return { impl, calls };
  }

  it('signs through /api/media/sign with credentials, not the browser client', async () => {
    const { client, calls: clientCalls } = fakeClient();
    const { impl, calls } = fakeFetch();
    const out = await getSignedMediaUrl(OBJ, {
      client,
      fetch: impl,
      supportSession: () => true,
      now: () => 1_000_000,
    });

    expect(clientCalls).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${MEDIA_SIGN_ENDPOINT}?url=${encodeURIComponent(OBJ)}`
    );
    expect(calls[0].init?.credentials).toBe('same-origin');
    expect(out).toEqual({ url: SIGNED, expiresAt: 1_000_000 + 600_000 });
  });

  it('outside a support session keeps signing with the browser client', async () => {
    const { client, calls: clientCalls } = fakeClient();
    const { impl, calls } = fakeFetch();
    const out = await getSignedMediaUrl(OBJ, {
      client,
      fetch: impl,
      supportSession: () => false,
    });
    expect(calls).toEqual([]);
    expect(clientCalls).toHaveLength(1);
    expect(out.url).toMatch(/token=t1$/);
  });

  it('falls back to the stored URL when the route refuses, without caching the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = fakeFetch(() =>
      Response.json({ error: 'Forbidden' }, { status: 403 })
    );
    const out = await getSignedMediaUrl(OBJ, {
      fetch: refused.impl,
      supportSession: () => true,
    });
    expect(out).toEqual({ url: OBJ, expiresAt: null });
    expect(warn).toHaveBeenCalled();

    const ok = fakeFetch();
    const next = await getSignedMediaUrl(OBJ, {
      fetch: ok.impl,
      supportSession: () => true,
      now: () => 1_000_000,
    });
    expect(next.url).toBe(SIGNED);
  });

  it('falls back when the request itself fails or the body has no URL', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = fakeFetch(() => Promise.reject(new TypeError('offline')));
    expect(
      await getSignedMediaUrl(OBJ, {
        fetch: down.impl,
        supportSession: () => true,
      })
    ).toEqual({ url: OBJ, expiresAt: null });
    const empty = fakeFetch(() => Response.json({}));
    expect(
      await getSignedMediaUrl(OBJ, {
        fetch: empty.impl,
        supportSession: () => true,
      })
    ).toEqual({ url: OBJ, expiresAt: null });
  });

  it('caches per object and shares the in-flight request', async () => {
    const { impl, calls } = fakeFetch();
    const opts = {
      fetch: impl,
      supportSession: () => true,
      now: () => 1_000_000,
    };
    const [a, b] = await Promise.all([
      getSignedMediaUrl(OBJ, opts),
      getSignedMediaUrl(OBJ, opts),
    ]);
    const c = await getSignedMediaUrl(OBJ, opts);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(c).toEqual(a);
  });

  it('computes the expiry on the browser clock, ignoring a server clock that runs behind', async () => {
    const NOW = 50_000_000;
    const { impl, calls } = fakeFetch(() =>
      Response.json({
        url: SIGNED,
        // The server is 10 minutes behind: its epoch deadline is already
        // in the browser's past.
        expiresAt: NOW - 10 * 60_000,
        expiresIn: SIGNED_URL_TTL_SECONDS,
      })
    );
    const opts = { fetch: impl, supportSession: () => true, now: () => NOW };
    const out = await getSignedMediaUrl(OBJ, opts);
    expect(out.expiresAt).toBe(NOW + SIGNED_URL_TTL_SECONDS * 1000);

    const again = await getSignedMediaUrl(OBJ, opts);
    expect(again).toEqual(out);
    expect(calls).toHaveLength(1);
  });

  it('never trusts a lifetime longer than the TTL, and defaults to it', async () => {
    const long = fakeFetch(() =>
      Response.json({
        url: SIGNED,
        expiresAt: 9_999_999_999,
        expiresIn: 86_400,
      })
    );
    const out = await getSignedMediaUrl(OBJ, {
      fetch: long.impl,
      supportSession: () => true,
      now: () => 1_000_000,
    });
    expect(out.expiresAt).toBe(1_000_000 + SIGNED_URL_TTL_SECONDS * 1000);

    __resetSignedUrlCache();
    const bare = fakeFetch(() => Response.json({ url: SIGNED }));
    const fallback = await getSignedMediaUrl(OBJ, {
      fetch: bare.impl,
      supportSession: () => true,
      now: () => 1_000_000,
    });
    expect(fallback.expiresAt).toBe(1_000_000 + SIGNED_URL_TTL_SECONDS * 1000);
  });

  it('leaves non-bucket URLs alone without calling the route', async () => {
    const { impl, calls } = fakeFetch();
    const out = await getSignedMediaUrl(PROXY, {
      fetch: impl,
      supportSession: () => true,
    });
    expect(out).toEqual({ url: PROXY, expiresAt: null });
    expect(calls).toEqual([]);
  });
});

describe('msUntilRefresh', () => {
  it('renews one margin before expiry and never sooner than a second', () => {
    const expiresAt = 10 * 60 * 1000;
    expect(msUntilRefresh(expiresAt, 0)).toBe(
      expiresAt - SIGNED_URL_REFRESH_MARGIN_MS
    );
    expect(msUntilRefresh(expiresAt, expiresAt)).toBe(1_000);
  });
});
