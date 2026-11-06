import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Meta resumable upload so the helper is tested in isolation.
vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'HANDLE123' })),
}));

// The SSRF guard does a real DNS lookup, so stub it — the fixtures below use
// a `.test` hostname that would never resolve. Each test sets the verdict.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { ensureImageHeaderHandle } from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { TemplatePayload } from './template-validators';

function payload(over: Partial<TemplatePayload> = {}): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'image',
    header_media_url: 'https://x.test/img.jpg',
    ...over,
  };
}

function imgResponse(type = 'image/jpeg', size = 1024, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Response;
}

describe('ensureImageHeaderHandle', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
    vi.mocked(isDeliverableUrl).mockClear();
    vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is a no-op for non-image headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi' });
    await ensureImageHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op when a handle already exists', async () => {
    const p = payload({ header_handle: 'existing' });
    await ensureImageHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBe('existing');
  });

  it('throws an actionable error when META_APP_ID is unset', async () => {
    const p = payload();
    await expect(ensureImageHeaderHandle(p, 'tok')).rejects.toThrow(/META_APP_ID/);
  });

  it('derives + sets header_handle from a valid image URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureImageHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a non-image content type', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('text/html')));
    await expect(ensureImageHeaderHandle(payload(), 'tok')).rejects.toThrow(/JPEG or PNG/);
  });

  it('rejects an image over 5 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/png', 6 * 1024 * 1024)));
    await expect(ensureImageHeaderHandle(payload(), 'tok')).rejects.toThrow(/5 MB/);
  });

  // Regression: `header_media_url` is caller-supplied and any authenticated
  // member can submit a template, so a non-public destination has to be
  // refused *before* the server issues the request — otherwise the status
  // and content-type carried back in the thrown error are an SSRF oracle for
  // loopback, RFC1918 and cloud-metadata addresses.
  it('refuses a non-public header URL without fetching it', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchSpy = vi.fn(async () => imgResponse('application/json'));
    vi.stubGlobal('fetch', fetchSpy);

    const p = payload({ header_media_url: 'http://169.254.169.254/latest/meta-data/' });
    await expect(ensureImageHeaderHandle(p, 'tok')).rejects.toThrow(/publicly reachable/);

    expect(isDeliverableUrl).toHaveBeenCalledWith('http://169.254.169.254/latest/meta-data/');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('reports a blocked URL exactly like an unreachable one', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');

    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse()));
    const blocked = await ensureImageHeaderHandle(payload(), 'tok').catch(
      (e: Error) => e.message,
    );

    vi.mocked(isDeliverableUrl).mockResolvedValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const unreachable = await ensureImageHeaderHandle(payload(), 'tok').catch(
      (e: Error) => e.message,
    );

    expect(blocked).toBe(unreachable);
  });

  it('does not follow redirects, so a public URL cannot bounce to an internal one', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    const fetchSpy = vi.fn(async () => imgResponse('image/jpeg', 1024));
    vi.stubGlobal('fetch', fetchSpy);

    await ensureImageHeaderHandle(payload(), 'tok');

    const init = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init).toMatchObject({ redirect: 'manual' });
  });
});

// m14.3 (H1): the sample image is read with the service role. A header
// URL whose decoded path looks like A's but normalises to B's object (or
// leaves Storage) must be refused before storage, fetch or Meta.
describe('ensureImageHeaderHandle — encoded traversal (m14.3)', () => {
  const ORIGIN = 'https://abc.supabase.co';
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const B = 'bbbbbbbb-0000-4000-8000-00000000000b';

  function source() {
    const downloads: string[] = [];
    return {
      downloads,
      src: {
        accountId: A,
        storage: {
          from: (bucket: string) => ({
            download: async (path: string) => {
              downloads.push(`${bucket}/${path}`);
              return {
                data: new Blob(['png'], { type: 'image/png' }),
                error: null,
              };
            },
          }),
        },
      },
    };
  }

  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    `account-${A}%2F..%2Faccount-${B}%2Fx.png`,
    `account-${A}/..%5Caccount-${B}%5Cx.png`,
    `account-${A}/%252e%252e/account-${B}/x.png`,
    `account-${A}/.%09./account-${B}/x.png`,
    `account-${A}/%0A..%2Faccount-${B}/x.png`,
    `account-${A}/x%3F/y.png`,
    `account-${A}/x%23/y.png`,
    `account-${A}/%C0%AE%C0%AE/account-${B}/x.png`,
    `account-${A}//account-${B}/x.png`,
    `account-${A}/..%2F..%2Fflow-media%2Faccount-${B}%2Fx.png`,
    `account-${A}/..%2F..%2F..%2F..%2F..%2Frest%2Fv1%2Fprofiles%3Fselect%3D*%23`,
    `account-${A}b/x.png`,
    `account-${B}/x.png`,
  ])('refuses %s with no storage, fetch or Meta call', async (v) => {
    const fetchSpy = vi.fn(async () => imgResponse('image/png'));
    vi.stubGlobal('fetch', fetchSpy);
    const { src, downloads } = source();
    const p = payload({
      header_media_url: `${ORIGIN}/storage/v1/object/public/chat-media/${v}`,
    });
    await expect(ensureImageHeaderHandle(p, 'tok', src)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'media_url points at an attachment that belongs to another account',
    });
    expect(downloads).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it("reads A's own canonical object and gets a handle", async () => {
    const { src, downloads } = source();
    const p = payload({
      header_media_url: `${ORIGIN}/storage/v1/object/public/chat-media/account-${A}/1-Foto%20Ma%C3%B1ana.png`,
    });
    await ensureImageHeaderHandle(p, 'tok', src);
    expect(downloads).toEqual([`chat-media/account-${A}/1-Foto Mañana.png`]);
    expect(p.header_handle).toBe('HANDLE123');
  });
});
