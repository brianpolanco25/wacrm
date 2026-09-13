import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSignedUrlCache,
  getSignedMediaUrl,
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

describe('msUntilRefresh', () => {
  it('renews one margin before expiry and never sooner than a second', () => {
    const expiresAt = 10 * 60 * 1000;
    expect(msUntilRefresh(expiresAt, 0)).toBe(
      expiresAt - SIGNED_URL_REFRESH_MARGIN_MS
    );
    expect(msUntilRefresh(expiresAt, expiresAt)).toBe(1_000);
  });
});
