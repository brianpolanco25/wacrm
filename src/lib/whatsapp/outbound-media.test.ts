import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOutboundMediaCache,
  assertMediaPathOwnedBy,
  OutboundMediaError,
  resolveOutboundMedia,
  resolveTemplateHeaderMedia,
  type OutboundMediaDb,
  type OutboundMediaStorage,
} from './outbound-media';
import type { MessageTemplate } from '@/types';
import type { uploadMedia } from './meta-api';

const ORIGIN = 'https://abc.supabase.co';
const A = 'acct-a';
const B = 'acct-b';
const OBJ_A = `${ORIGIN}/storage/v1/object/public/chat-media/account-${A}/1-photo.png`;
const OBJ_B = `${ORIGIN}/storage/v1/object/public/chat-media/account-${B}/1-secret.pdf`;
const LEGACY_UID = '9f1b2c3d-0000-4000-8000-000000000000';
const OBJ_LEGACY = `${ORIGIN}/storage/v1/object/public/flow-media/${LEGACY_UID}/1-old.pdf`;

/** Records downloads; serves a typed or untyped blob per path. */
function fakeStorage(files: Record<string, { bytes?: string; type?: string }>) {
  const downloads: string[] = [];
  const storage: OutboundMediaStorage = {
    from: (bucket) => ({
      download: async (path) => {
        downloads.push(`${bucket}/${path}`);
        const f = files[`${bucket}/${path}`];
        if (!f) return { data: null, error: { message: 'Object not found' } };
        return {
          data: new Blob([f.bytes ?? 'bytes'], { type: f.type ?? '' }),
          error: null,
        };
      },
    }),
  };
  return { storage, downloads };
}

/** profiles lookup: which uids belong to which account. */
function fakeDb(members: Record<string, string>): OutboundMediaDb {
  return {
    from: () => ({
      select: () => ({
        eq: (_c: string, uid: unknown) => ({
          eq: (_c2: string, accountId: unknown) => ({
            maybeSingle: async () => ({
              data:
                members[String(uid)] === accountId ? { user_id: uid } : null,
              error: null,
            }),
          }),
        }),
      }),
    }),
  };
}

const upload = vi.fn<typeof uploadMedia>(async () => ({ mediaId: 'MEDIA-1' }));

const BASE = {
  accountId: A,
  phoneNumberId: 'pn-1',
  accessToken: 'tok',
  upload,
};

beforeEach(() => {
  __resetOutboundMediaCache();
  upload.mockClear();
  upload.mockResolvedValue({ mediaId: 'MEDIA-1' });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveOutboundMedia', () => {
  it('passes an external URL through as a link without touching storage', async () => {
    const { storage, downloads } = fakeStorage({});
    const out = await resolveOutboundMedia({
      ...BASE,
      storage,
      mediaUrl: 'https://cdn.example.com/brochure.pdf',
    });
    expect(out).toEqual({ link: 'https://cdn.example.com/brochure.pdf' });
    expect(downloads).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });

  it('downloads one of our bucket objects with the service role and sends by media id', async () => {
    const { storage, downloads } = fakeStorage({
      [`chat-media/account-${A}/1-photo.png`]: { type: 'image/png' },
    });
    const out = await resolveOutboundMedia({
      ...BASE,
      storage,
      mediaUrl: OBJ_A,
    });

    expect(out).toEqual({ mediaId: 'MEDIA-1' });
    expect(downloads).toEqual([`chat-media/account-${A}/1-photo.png`]);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'tok',
        mimeType: 'image/png',
        fileName: '1-photo.png',
      })
    );
  });

  it('infers the MIME type from the extension when storage returns an untyped blob', async () => {
    const { storage } = fakeStorage({
      [`chat-media/account-${A}/1-photo.png`]: { type: '' },
    });
    await resolveOutboundMedia({ ...BASE, storage, mediaUrl: OBJ_A });
    expect(upload.mock.calls[0][0]).toMatchObject({ mimeType: 'image/png' });
  });

  it('prefers the caller-supplied document filename', async () => {
    const { storage } = fakeStorage({
      [`chat-media/account-${A}/1-photo.png`]: { type: 'image/png' },
    });
    await resolveOutboundMedia({
      ...BASE,
      storage,
      mediaUrl: OBJ_A,
      fileName: 'Invoice March.png',
    });
    expect(upload.mock.calls[0][0]).toMatchObject({
      fileName: 'Invoice March.png',
    });
  });

  it('caches the media id per (phone number, object) so repeats cost nothing', async () => {
    const { storage, downloads } = fakeStorage({
      [`chat-media/account-${A}/1-photo.png`]: { type: 'image/png' },
    });
    await resolveOutboundMedia({ ...BASE, storage, mediaUrl: OBJ_A });
    await resolveOutboundMedia({ ...BASE, storage, mediaUrl: OBJ_A });
    expect(downloads).toHaveLength(1);
    expect(upload).toHaveBeenCalledTimes(1);

    // Another phone number is another Meta account — its own upload.
    await resolveOutboundMedia({
      ...BASE,
      storage,
      mediaUrl: OBJ_A,
      phoneNumberId: 'pn-2',
    });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('expires cached ids after a day', async () => {
    const { storage } = fakeStorage({
      [`chat-media/account-${A}/1-photo.png`]: { type: 'image/png' },
    });
    let clock = 1_000;
    const now = () => clock;
    await resolveOutboundMedia({ ...BASE, storage, mediaUrl: OBJ_A, now });
    clock += 25 * 60 * 60 * 1000;
    await resolveOutboundMedia({ ...BASE, storage, mediaUrl: OBJ_A, now });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  // Tenancy — the reason this check exists at all.
  it("refuses another account's object before reading a single byte", async () => {
    const { storage, downloads } = fakeStorage({
      [`chat-media/account-${B}/1-secret.pdf`]: { type: 'application/pdf' },
    });
    await expect(
      resolveOutboundMedia({ ...BASE, storage, mediaUrl: OBJ_B })
    ).rejects.toMatchObject({ name: 'OutboundMediaError', code: 'forbidden' });
    expect(downloads).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });

  it('lets an account member send a legacy <uid>/ path uploaded by another member', async () => {
    const { storage } = fakeStorage({
      [`flow-media/${LEGACY_UID}/1-old.pdf`]: { type: 'application/pdf' },
    });
    const out = await resolveOutboundMedia({
      ...BASE,
      storage,
      mediaUrl: OBJ_LEGACY,
      db: fakeDb({ [LEGACY_UID]: A }),
    });
    expect(out).toEqual({ mediaId: 'MEDIA-1' });
  });

  it('refuses a legacy <uid>/ path whose uploader is in another account, or when no db is given', async () => {
    const { storage } = fakeStorage({
      [`flow-media/${LEGACY_UID}/1-old.pdf`]: { type: 'application/pdf' },
    });
    await expect(
      resolveOutboundMedia({
        ...BASE,
        storage,
        mediaUrl: OBJ_LEGACY,
        db: fakeDb({ [LEGACY_UID]: B }),
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      resolveOutboundMedia({ ...BASE, storage, mediaUrl: OBJ_LEGACY })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('treats a look-alike URL on a foreign host as an external link', async () => {
    const { storage, downloads } = fakeStorage({});
    const foreign = `https://other.supabase.co/storage/v1/object/public/chat-media/account-${B}/x.png`;
    const out = await resolveOutboundMedia({
      ...BASE,
      storage,
      mediaUrl: foreign,
    });
    expect(out).toEqual({ link: foreign });
    expect(downloads).toEqual([]);
  });

  it('ignores non-media buckets (avatars) and passes them through', async () => {
    const { storage } = fakeStorage({});
    const avatar = `${ORIGIN}/storage/v1/object/public/avatars/u1/a.png`;
    expect(
      await resolveOutboundMedia({ ...BASE, storage, mediaUrl: avatar })
    ).toEqual({ link: avatar });
  });

  it('surfaces a missing object and a refused upload as typed errors', async () => {
    const { storage } = fakeStorage({});
    await expect(
      resolveOutboundMedia({ ...BASE, storage, mediaUrl: OBJ_A })
    ).rejects.toMatchObject({ code: 'not_found' });

    const present = fakeStorage({
      [`chat-media/account-${A}/1-photo.png`]: { type: 'image/png' },
    });
    upload.mockRejectedValueOnce(new Error('(#131053) Media upload error'));
    await expect(
      resolveOutboundMedia({
        ...BASE,
        storage: present.storage,
        mediaUrl: OBJ_A,
      })
    ).rejects.toMatchObject({
      code: 'upload_failed',
      message: expect.stringContaining('131053'),
    });
  });
});

describe('assertMediaPathOwnedBy', () => {
  it('decides account-scoped paths by their first segment', async () => {
    await expect(
      assertMediaPathOwnedBy(`account-${A}/x.png`, A)
    ).resolves.toBeUndefined();
    await expect(
      assertMediaPathOwnedBy(`account-${B}/x.png`, A)
    ).rejects.toBeInstanceOf(OutboundMediaError);
  });

  it('refuses paths with neither convention', async () => {
    await expect(
      assertMediaPathOwnedBy('inbound/x.png', A)
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('resolveTemplateHeaderMedia', () => {
  const template = (over: Partial<MessageTemplate> = {}): MessageTemplate =>
    ({
      id: 't1',
      name: 'promo',
      header_type: 'image',
      header_media_url: OBJ_A,
      body_text: 'hi',
      ...over,
    }) as MessageTemplate;

  it('swaps a bucket-hosted header link for a media id', async () => {
    const { storage } = fakeStorage({
      [`chat-media/account-${A}/1-photo.png`]: { type: 'image/png' },
    });
    const params = await resolveTemplateHeaderMedia(
      template(),
      { body: ['x'] },
      {
        ...BASE,
        storage,
      }
    );
    expect(params).toEqual({
      body: ['x'],
      headerMediaUrl: undefined,
      headerMediaId: 'MEDIA-1',
    });
  });

  it('uses the per-send override link when present', async () => {
    const override = `${ORIGIN}/storage/v1/object/public/chat-media/account-${A}/2-other.png`;
    const { storage, downloads } = fakeStorage({
      [`chat-media/account-${A}/2-other.png`]: { type: 'image/png' },
    });
    await resolveTemplateHeaderMedia(
      template(),
      { headerMediaUrl: override },
      {
        ...BASE,
        storage,
      }
    );
    expect(downloads).toEqual([`chat-media/account-${A}/2-other.png`]);
  });

  it('leaves text headers, missing links, external links and explicit ids alone', async () => {
    const { storage, downloads } = fakeStorage({});
    expect(
      await resolveTemplateHeaderMedia(
        template({ header_type: 'text' }),
        undefined,
        {
          ...BASE,
          storage,
        }
      )
    ).toBeUndefined();
    expect(
      await resolveTemplateHeaderMedia(
        template({ header_media_url: undefined }),
        undefined,
        {
          ...BASE,
          storage,
        }
      )
    ).toBeUndefined();
    const external = { headerMediaUrl: 'https://cdn.example.com/h.png' };
    expect(
      await resolveTemplateHeaderMedia(template(), external, {
        ...BASE,
        storage,
      })
    ).toBe(external);
    const withId = { headerMediaId: 'ALREADY' };
    expect(
      await resolveTemplateHeaderMedia(template(), withId, { ...BASE, storage })
    ).toBe(withId);
    expect(downloads).toEqual([]);
    expect(
      await resolveTemplateHeaderMedia(null, undefined, { ...BASE, storage })
    ).toBeUndefined();
  });

  it("refuses a header that points at another account's object", async () => {
    const { storage } = fakeStorage({});
    await expect(
      resolveTemplateHeaderMedia(
        template({ header_media_url: OBJ_B }),
        undefined,
        {
          ...BASE,
          storage,
        }
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
