import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadVoiceNoteAudio,
  type LoadVoiceNoteAudioArgs,
  type VoiceNoteStorage,
} from './audio-source';

const ORIGIN = 'https://proj.supabase.co';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'EAAG-secret-token';
const url = (path: string) =>
  `${ORIGIN}/storage/v1/object/public/chat-media/${path}`;

function storageWith(
  blob: Blob | null,
  error: { message: string } | null = null
) {
  const download = vi.fn(async () => ({ data: blob, error }));
  const from = vi.fn(() => ({ download }));
  return { storage: { from } as VoiceNoteStorage, from, download };
}

const fetchSpy = vi.fn();
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = (over: Partial<LoadVoiceNoteAudioArgs>): LoadVoiceNoteAudioArgs =>
  ({
    accountId: A,
    mediaUrl: null,
    mediaType: 'audio/ogg; codecs=opus',
    source: { metaMediaId: '123', accessToken: TOKEN },
    storage: storageWith(null).storage,
    maxBytes: 100,
    getUrl: vi.fn(),
    download: vi.fn(),
    ...over,
  }) as LoadVoiceNoteAudioArgs;

describe('loadVoiceNoteAudio — chat-media (R12)', () => {
  it('downloads an account-A object with its path', async () => {
    const s = storageWith(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/ogg' })
    );
    const out = await loadVoiceNoteAudio(
      base({
        storage: s.storage,
        mediaUrl: url(`account-${A}/inbound/1-audio-2.ogg`),
      })
    );
    expect(s.from).toHaveBeenCalledWith('chat-media');
    expect(s.download).toHaveBeenCalledWith(
      `account-${A}/inbound/1-audio-2.ogg`
    );
    expect(out).toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/ogg',
    });
  });

  it('refuses account B, without downloading', async () => {
    const s = storageWith(new Blob([]));
    const out = await loadVoiceNoteAudio(
      base({ storage: s.storage, mediaUrl: url(`account-${B}/inbound/x.ogg`) })
    );
    expect(out).toEqual({
      ok: false,
      status: 'failed',
      reason: 'forbidden_path',
    });
    expect(s.download).not.toHaveBeenCalled();
  });

  it('refuses a legacy <uuid>/… path', async () => {
    const s = storageWith(new Blob([]));
    const out = await loadVoiceNoteAudio(
      base({ storage: s.storage, mediaUrl: url(`${A}/x.ogg`) })
    );
    expect(out).toMatchObject({ ok: false, reason: 'forbidden_path' });
    expect(s.download).not.toHaveBeenCalled();
  });

  it('refuses .. and %2F on our origin', async () => {
    const s = storageWith(new Blob([]));
    for (const path of [
      `account-${A}/../account-${B}/x.ogg`,
      `account-${A}%2F..%2Faccount-${B}%2Fx.ogg`,
    ]) {
      const out = await loadVoiceNoteAudio(
        base({ storage: s.storage, mediaUrl: url(path) })
      );
      expect(out).toMatchObject({ ok: false, reason: 'forbidden_path' });
    }
    expect(s.download).not.toHaveBeenCalled();
  });

  it('refuses another bucket of ours', async () => {
    const s = storageWith(new Blob([]));
    const out = await loadVoiceNoteAudio(
      base({
        storage: s.storage,
        mediaUrl: `${ORIGIN}/storage/v1/object/public/flow-media/account-${A}/x.ogg`,
      })
    );
    expect(out).toMatchObject({ ok: false, reason: 'forbidden_path' });
    expect(s.download).not.toHaveBeenCalled();
  });

  it('never fetches an arbitrary URL', async () => {
    const s = storageWith(new Blob([]));
    const getUrl = vi.fn();
    const download = vi.fn();
    const out = await loadVoiceNoteAudio(
      base({
        storage: s.storage,
        mediaUrl: 'https://evil.example/a.ogg',
        getUrl,
        download,
      })
    );
    expect(out).toMatchObject({ ok: false, reason: 'forbidden_path' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(s.download).not.toHaveBeenCalled();
  });

  it('a storage error → download_failed', async () => {
    const s = storageWith(null, { message: 'nope' });
    const out = await loadVoiceNoteAudio(
      base({ storage: s.storage, mediaUrl: url(`account-${A}/inbound/x.ogg`) })
    );
    expect(out).toEqual({
      ok: false,
      status: 'failed',
      reason: 'download_failed',
    });
  });

  it('a downloaded object over the limit → skipped/too_large', async () => {
    const s = storageWith(new Blob([new Uint8Array(101)]));
    const out = await loadVoiceNoteAudio(
      base({ storage: s.storage, mediaUrl: url(`account-${A}/inbound/x.ogg`) })
    );
    expect(out).toEqual({ ok: false, status: 'skipped', reason: 'too_large' });
  });
});

describe('loadVoiceNoteAudio — Meta (R13, R14)', () => {
  it('uses getMediaUrl + downloadMedia with the media id and token for the proxy URL', async () => {
    const s = storageWith(null);
    const getUrl = vi.fn(async () => ({
      url: 'https://cdn.meta/x',
      mimeType: 'audio/ogg',
      fileSize: 10,
    }));
    const download = vi.fn(async () => ({
      buffer: Buffer.from([9, 9]),
      contentType: 'audio/ogg',
    }));
    const out = await loadVoiceNoteAudio(
      base({
        storage: s.storage,
        mediaUrl: '/api/whatsapp/media/123',
        getUrl,
        download,
      })
    );
    expect(getUrl).toHaveBeenCalledWith({ mediaId: '123', accessToken: TOKEN });
    expect(download).toHaveBeenCalledWith({
      downloadUrl: 'https://cdn.meta/x',
      accessToken: TOKEN,
    });
    expect(out).toEqual({
      ok: true,
      bytes: new Uint8Array([9, 9]),
      mimeType: 'audio/ogg',
    });
    expect(s.from).not.toHaveBeenCalled();
  });

  it('also goes to Meta when media_url is null', async () => {
    const getUrl = vi.fn(async () => ({
      url: 'https://cdn.meta/x',
      mimeType: 'audio/ogg',
      fileSize: null,
    }));
    const download = vi.fn(async () => ({
      buffer: Buffer.from([1]),
      contentType: 'audio/ogg',
    }));
    const out = await loadVoiceNoteAudio(
      base({
        storage: storageWith(null).storage,
        mediaUrl: null,
        mediaType: null,
        getUrl,
        download,
      })
    );
    expect(out).toEqual({
      ok: true,
      bytes: new Uint8Array([1]),
      mimeType: 'audio/ogg',
    });
  });

  it('a declared fileSize over the limit → too_large without downloading', async () => {
    const getUrl = vi.fn(async () => ({
      url: 'https://cdn.meta/x',
      mimeType: 'audio/ogg',
      fileSize: 500,
    }));
    const download = vi.fn();
    const out = await loadVoiceNoteAudio(
      base({
        storage: storageWith(null).storage,
        mediaUrl: '/api/whatsapp/media/123',
        getUrl,
        download,
      })
    );
    expect(out).toEqual({ ok: false, status: 'skipped', reason: 'too_large' });
    expect(download).not.toHaveBeenCalled();
  });

  it('downloaded bytes over the limit → too_large', async () => {
    const getUrl = vi.fn(async () => ({
      url: 'u',
      mimeType: 'audio/ogg',
      fileSize: null,
    }));
    const download = vi.fn(async () => ({
      buffer: Buffer.alloc(101),
      contentType: 'audio/ogg',
    }));
    const out = await loadVoiceNoteAudio(
      base({ storage: storageWith(null).storage, getUrl, download })
    );
    expect(out).toEqual({ ok: false, status: 'skipped', reason: 'too_large' });
  });

  it('a Meta error → download_failed, and the token never reaches console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {})
    );
    const getUrl = vi.fn(async () => {
      throw new Error(`Media fetch failed with ${TOKEN}`);
    });
    const out = await loadVoiceNoteAudio(
      base({ storage: storageWith(null).storage, getUrl })
    );
    expect(out).toEqual({
      ok: false,
      status: 'failed',
      reason: 'download_failed',
    });
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(TOKEN);
      }
    }
  });
});
