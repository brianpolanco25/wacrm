import { describe, expect, it } from 'vitest';
import {
  accountIdFromPath,
  isMediaBucketUrl,
  legacyOwnerFromPath,
  parseStorageObjectUrl,
} from './storage-url';

const ORIGIN = 'https://abc.supabase.co';
const PUBLIC = `${ORIGIN}/storage/v1/object/public/chat-media/account-a1/1-photo.png`;

describe('parseStorageObjectUrl', () => {
  it('parses the public-object shape getPublicUrl() produces', () => {
    expect(parseStorageObjectUrl(PUBLIC)).toEqual({
      bucket: 'chat-media',
      path: 'account-a1/1-photo.png',
    });
  });

  it('parses signed and authenticated object routes too', () => {
    expect(
      parseStorageObjectUrl(
        `${ORIGIN}/storage/v1/object/sign/flow-media/account-a1/x.pdf?token=abc`
      )
    ).toEqual({ bucket: 'flow-media', path: 'account-a1/x.pdf' });
    expect(
      parseStorageObjectUrl(
        `${ORIGIN}/storage/v1/object/authenticated/flow-media/account-a1/x.pdf`
      )
    ).toEqual({ bucket: 'flow-media', path: 'account-a1/x.pdf' });
  });

  it('decodes percent-encoded path segments and keeps nesting', () => {
    expect(
      parseStorageObjectUrl(
        `${ORIGIN}/storage/v1/object/public/chat-media/account-a1/inbound/my%20file.pdf`
      )
    ).toEqual({ bucket: 'chat-media', path: 'account-a1/inbound/my file.pdf' });
  });

  it('returns null for anything that is not a storage object URL', () => {
    expect(
      parseStorageObjectUrl('https://cdn.example.com/file.jpg')
    ).toBeNull();
    expect(parseStorageObjectUrl('/api/whatsapp/media/123')).toBeNull();
    expect(parseStorageObjectUrl('not a url')).toBeNull();
    expect(
      parseStorageObjectUrl(`${ORIGIN}/storage/v1/bucket/chat-media`)
    ).toBeNull();
    // A bucket with no object path is not an object.
    expect(
      parseStorageObjectUrl(`${ORIGIN}/storage/v1/object/public/chat-media`)
    ).toBeNull();
    expect(
      parseStorageObjectUrl(`ftp://x/storage/v1/object/public/b/p`)
    ).toBeNull();
  });

  it('with an origin, only accepts URLs on that host', () => {
    expect(parseStorageObjectUrl(PUBLIC, { origin: ORIGIN })).not.toBeNull();
    expect(
      parseStorageObjectUrl(PUBLIC, { origin: `${ORIGIN}/` })
    ).not.toBeNull();
    expect(
      parseStorageObjectUrl(PUBLIC, { origin: 'https://other.supabase.co' })
    ).toBeNull();
    // A look-alike path on a foreign host must not be treated as ours.
    expect(
      parseStorageObjectUrl(
        'https://evil.example/storage/v1/object/public/chat-media/account-a1/x.png',
        { origin: ORIGIN }
      )
    ).toBeNull();
  });
});

describe('isMediaBucketUrl', () => {
  it('is true only for the two media buckets', () => {
    expect(isMediaBucketUrl(PUBLIC)).toBe(true);
    expect(
      isMediaBucketUrl(`${ORIGIN}/storage/v1/object/public/avatars/u1/a.png`)
    ).toBe(false);
    expect(isMediaBucketUrl('https://cdn.example.com/x.png')).toBe(false);
  });
});

describe('path ownership helpers', () => {
  it('reads the account id from an account-scoped path', () => {
    expect(accountIdFromPath('account-a1/1-photo.png')).toBe('a1');
    expect(accountIdFromPath('account-/x')).toBeNull();
    expect(
      accountIdFromPath('9f1b2c3d-0000-4000-8000-000000000000/x.png')
    ).toBeNull();
  });

  it('reads the uploader from a legacy uid path', () => {
    expect(
      legacyOwnerFromPath('9f1b2c3d-0000-4000-8000-000000000000/1-x.png')
    ).toBe('9f1b2c3d-0000-4000-8000-000000000000');
    expect(legacyOwnerFromPath('account-a1/x.png')).toBeNull();
    expect(legacyOwnerFromPath('inbound/x.png')).toBeNull();
  });
});
