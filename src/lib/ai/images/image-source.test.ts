import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceNoteStorage } from '../voice/audio-source';
import { loadInboundImage, type LoadInboundImageArgs } from './image-source';

const ORIGIN = 'https://proj.supabase.co';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'EAAG-secret-token';
const url = (path: string) =>
  `${ORIGIN}/storage/v1/object/public/chat-media/${path}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

function storageWith(
  blob: Blob | null,
  error: { message: string } | null = null
) {
  const download = vi.fn(async () => ({ data: blob, error }));
  const from = vi.fn(() => ({ download }));
  return { storage: { from } as VoiceNoteStorage, from, download };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const base = (over: Partial<LoadInboundImageArgs>): LoadInboundImageArgs => ({
  accountId: A,
  mediaUrl: null,
  storage: storageWith(null).storage,
  maxBytes: 100,
  timeoutMs: 1000,
  getUrl: vi.fn(),
  download: vi.fn(),
  ...over,
});

describe('loadInboundImage — chat-media (R11, R13)', () => {
  it('downloads an own canonical object; MIME comes from the bytes', async () => {
    // The blob claims JPEG; the bytes are PNG → PNG is what is sent on.
    const s = storageWith(new Blob([PNG], { type: 'image/jpeg' }));
    const out = await loadInboundImage(
      base({
        storage: s.storage,
        mediaUrl: url(`account-${A}/inbound/1-image-2.jpg`),
      })
    );
    expect(s.from).toHaveBeenCalledWith('chat-media');
    expect(s.download).toHaveBeenCalledWith(
      `account-${A}/inbound/1-image-2.jpg`
    );
    expect(out).toEqual({
      ok: true,
      image: {
        mimeType: 'image/png',
        data: Buffer.from(PNG).toString('base64'),
      },
    });
  });

  it('cross-account leak (CP3): account A never downloads account B', async () => {
    const s = storageWith(new Blob([JPEG]));
    const out = await loadInboundImage(
      base({ storage: s.storage, mediaUrl: url(`account-${B}/inbound/x.jpg`) })
    );
    expect(out).toEqual({ ok: false, reason: 'forbidden_path' });
    // And B reading its own path works, so the refusal is about ownership.
    const ok = await loadInboundImage(
      base({
        accountId: B,
        storage: s.storage,
        mediaUrl: url(`account-${B}/inbound/x.jpg`),
      })
    );
    expect(ok.ok).toBe(true);
    expect(s.download).toHaveBeenCalledTimes(1);
    expect(s.download).toHaveBeenCalledWith(`account-${B}/inbound/x.jpg`);
  });

  it('refuses legacy, .., %2F, another bucket and another origin without downloading', async () => {
    const s = storageWith(new Blob([JPEG]));
    for (const mediaUrl of [
      url(`${A}/x.jpg`),
      url(`account-${A}/../account-${B}/x.jpg`),
      url(`account-${A}%2F..%2Faccount-${B}%2Fx.jpg`),
      `${ORIGIN}/storage/v1/object/public/flow-media/account-${A}/x.jpg`,
      `https://evil.example/storage/v1/object/public/chat-media/account-${A}/x.jpg`,
      'https://evil.example/a.jpg',
    ]) {
      const out = await loadInboundImage(
        base({ storage: s.storage, mediaUrl })
      );
      expect(out).toEqual({ ok: false, reason: 'forbidden_path' });
    }
    expect(s.download).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a storage error → download_failed', async () => {
    const s = storageWith(null, { message: 'nope' });
    const out = await loadInboundImage(
      base({ storage: s.storage, mediaUrl: url(`account-${A}/inbound/x.jpg`) })
    );
    expect(out).toEqual({ ok: false, reason: 'download_failed' });
  });

  it('a download that throws → download_failed', async () => {
    const download = vi.fn(async () => {
      throw new Error('boom');
    });
    const storage = { from: () => ({ download }) } as VoiceNoteStorage;
    const out = await loadInboundImage(
      base({ storage, mediaUrl: url(`account-${A}/inbound/x.jpg`) })
    );
    expect(out).toEqual({ ok: false, reason: 'download_failed' });
  });

  it('bytes over the limit → too_large', async () => {
    const s = storageWith(new Blob([JPEG]));
    const out = await loadInboundImage(
      base({
        storage: s.storage,
        maxBytes: 3,
        mediaUrl: url(`account-${A}/inbound/x.jpg`),
      })
    );
    expect(out).toEqual({ ok: false, reason: 'too_large' });
  });

  it('an unknown signature → unsupported_format', async () => {
    const s = storageWith(new Blob([new TextEncoder().encode('GIF89a...')]));
    const out = await loadInboundImage(
      base({ storage: s.storage, mediaUrl: url(`account-${A}/inbound/x.gif`) })
    );
    expect(out).toEqual({ ok: false, reason: 'unsupported_format' });
  });

  it('a download that never resolves → timeout', async () => {
    vi.useFakeTimers();
    const download = vi.fn(() => new Promise<never>(() => {}));
    const storage = { from: () => ({ download }) } as VoiceNoteStorage;
    const pending = loadInboundImage(
      base({
        storage,
        timeoutMs: 10,
        mediaUrl: url(`account-${A}/inbound/x.jpg`),
      })
    );
    await vi.advanceTimersByTimeAsync(11);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('loadInboundImage — Meta (R12)', () => {
  it('a proxy URL without source → no_source, no network', async () => {
    const getUrl = vi.fn();
    for (const mediaUrl of ['/api/whatsapp/media/123', null]) {
      const out = await loadInboundImage(base({ mediaUrl, getUrl }));
      expect(out).toEqual({ ok: false, reason: 'no_source' });
    }
    expect(getUrl).not.toHaveBeenCalled();
  });

  it('a proxy URL with source → getMediaUrl + downloadMedia', async () => {
    const getUrl = vi.fn(async () => ({
      url: 'https://lookaside/x',
      mimeType: 'image/jpeg',
      fileSize: 7,
    }));
    const download = vi.fn(async () => ({
      buffer: Buffer.from(JPEG),
      contentType: 'image/jpeg',
    }));
    const out = await loadInboundImage(
      base({
        mediaUrl: '/api/whatsapp/media/123',
        source: { metaMediaId: '123', accessToken: TOKEN },
        getUrl,
        download,
      })
    );
    expect(getUrl).toHaveBeenCalledWith({ mediaId: '123', accessToken: TOKEN });
    expect(download).toHaveBeenCalledWith({
      downloadUrl: 'https://lookaside/x',
      accessToken: TOKEN,
    });
    expect(out).toEqual({
      ok: true,
      image: {
        mimeType: 'image/jpeg',
        data: Buffer.from(JPEG).toString('base64'),
      },
    });
  });

  it('a declared fileSize over the limit → too_large without downloading', async () => {
    const getUrl = vi.fn(async () => ({
      url: 'https://lookaside/x',
      mimeType: 'image/jpeg',
      fileSize: 101,
    }));
    const download = vi.fn();
    const out = await loadInboundImage(
      base({
        source: { metaMediaId: '123', accessToken: TOKEN },
        getUrl,
        download,
      })
    );
    expect(out).toEqual({ ok: false, reason: 'too_large' });
    expect(download).not.toHaveBeenCalled();
  });

  it('a Meta failure → download_failed', async () => {
    const getUrl = vi.fn(async () => {
      throw new Error('Meta 500');
    });
    const out = await loadInboundImage(
      base({ source: { metaMediaId: '123', accessToken: TOKEN }, getUrl })
    );
    expect(out).toEqual({ ok: false, reason: 'download_failed' });
  });
});
