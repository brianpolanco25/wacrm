import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No real network, ever (the graph.facebook.com incident): Meta is
// mocked, and any fetch that slips through fails the test.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}));

import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { resolveInboundMediaUrl } from './inbound-media-url';

const mockGetMediaUrl = vi.mocked(getMediaUrl);
const mockDownloadMedia = vi.mocked(downloadMedia);

const TOKEN = 'tok-secreto-4471';
const ACCOUNT = 'acct-a';
const MEDIA_ID = '998877';

function fakeStorage(uploadError: { message: string } | null = null) {
  const uploads: { bucket: string; path: string }[] = [];
  return {
    uploads,
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string) {
            uploads.push({ bucket, path });
            return { error: uploadError };
          },
          getPublicUrl(path: string) {
            return {
              data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
            };
          },
        };
      },
    },
  };
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('network access is forbidden in tests');
    })
  );
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
  }
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.test/media',
    mimeType: 'image/jpeg',
    fileSize: 1024,
  });
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(16),
    contentType: 'image/jpeg',
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveInboundMediaUrl', () => {
  it('mirror on → verifies with Meta (id, token) and returns the bucket URL', async () => {
    const { storage, uploads } = fakeStorage();
    const url = await resolveInboundMediaUrl({
      mediaId: MEDIA_ID,
      accessToken: TOKEN,
      mirror: { storage, accountId: ACCOUNT },
      messageTimestamp: '1762100000',
    });
    expect(mockGetMediaUrl).toHaveBeenCalledWith({
      mediaId: MEDIA_ID,
      accessToken: TOKEN,
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe('chat-media');
    expect(uploads[0].path).toContain(ACCOUNT);
    expect(url).toBe(`https://cdn.test/chat-media/${uploads[0].path}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('document → the sender file name reaches the mirrored object', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.test/media',
      mimeType: 'application/pdf',
      fileSize: 10,
    });
    const { storage, uploads } = fakeStorage();
    await resolveInboundMediaUrl({
      mediaId: MEDIA_ID,
      accessToken: TOKEN,
      mirror: { storage, accountId: ACCOUNT },
      fileName: 'factura.pdf',
    });
    expect(uploads[0].path).toContain('factura');
  });

  it('mirror off → proxy URL, nothing downloaded', async () => {
    const url = await resolveInboundMediaUrl({
      mediaId: MEDIA_ID,
      accessToken: TOKEN,
      mirror: null,
    });
    expect(url).toBe(`/api/whatsapp/media/${MEDIA_ID}`);
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it('mirror fails (upload error) → proxy URL', async () => {
    const { storage } = fakeStorage({ message: 'mime not allowed' });
    const url = await resolveInboundMediaUrl({
      mediaId: MEDIA_ID,
      accessToken: TOKEN,
      mirror: { storage, accountId: ACCOUNT },
    });
    expect(url).toBe(`/api/whatsapp/media/${MEDIA_ID}`);
  });

  it('Meta fails → null, logged without the token, never throws', async () => {
    mockGetMediaUrl.mockRejectedValue(new Error('Media fetch failed: 400'));
    const { storage, uploads } = fakeStorage();
    const url = await resolveInboundMediaUrl({
      mediaId: MEDIA_ID,
      accessToken: TOKEN,
      mirror: { storage, accountId: ACCOUNT },
    });
    expect(url).toBeNull();
    expect(uploads).toHaveLength(0);
    expect(logs.join('\n')).toContain(MEDIA_ID);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});
