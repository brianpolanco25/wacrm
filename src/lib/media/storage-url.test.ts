import { describe, expect, it } from 'vitest';
import {
  accountIdFromPath,
  assertStoragePathOwnedBy,
  isCanonicalStoragePath,
  isMediaBucketUrl,
  isOnOrigin,
  legacyOwnerFromPath,
  parseStorageObjectUrl,
  StoragePathForbiddenError,
} from './storage-url';
import { buildMediaPath } from '@/lib/storage/upload-media';

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
    const id = '9f1b2c3d-0000-4000-8000-0000000000a1';
    expect(accountIdFromPath(`account-${id}/1-photo.png`)).toBe(id);
    // Only a whole UUID is an account folder.
    expect(accountIdFromPath('account-a1/1-photo.png')).toBeNull();
    expect(accountIdFromPath(`account-${id}x/1-photo.png`)).toBeNull();
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

// ------------------------------------------------------------------
// m14.3 — canonical paths. storage-js interpolates the decoded path into
// the request URL unencoded and fetch normalises it afterwards, so any
// path fetch would rewrite must be refused here (C1/H1 of
// progress/sec_storage-path-normalization.md).
// ------------------------------------------------------------------

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const objectUrl = (rest: string, bucket = 'chat-media') =>
  `${ORIGIN}/storage/v1/object/public/${bucket}/${rest}`;

/** Every vector of the audit's table, plus the edge cases A1 names. */
const VECTORS: [string, string][] = [
  ['%2F..%2F', `account-${A}%2F..%2Faccount-${B}%2Fx.png`],
  ['%5C (backslash)', `account-${A}/..%5Caccount-${B}%5Cx.png`],
  [
    '%252e%252e (double encoding)',
    `account-${A}/%252e%252e/account-${B}/x.png`,
  ],
  ['.%09. (tab)', `account-${A}/.%09./account-${B}/x.png`],
  ['%0A (newline)', `account-${A}/%0A..%2Faccount-${B}/x.png`],
  ['%0D (carriage return)', `account-${A}/%0D/x.png`],
  ['%00 (NUL)', `account-${A}/x%00.png`],
  ['%7F (DEL)', `account-${A}/x%7F.png`],
  ['%3F (query)', `account-${A}/x%3Fy.png`],
  ['%23 (fragment)', `account-${A}/x%23y.png`],
  ['%C0%AE (overlong dot)', `account-${A}/%C0%AE%C0%AE/account-${B}/x.png`],
  ['// (empty segment)', `account-${A}//account-${B}/x.png`],
  ['trailing slash', `account-${A}/x.png/`],
  ['%2F%2F (encoded empty segment)', `account-${A}%2F%2Fx.png`],
  ['other bucket', `account-${A}/..%2F..%2Fflow-media%2Faccount-${B}%2Fx.png`],
  [
    '/rest/v1',
    `account-${A}/..%2F..%2F..%2F..%2F..%2Frest%2Fv1%2Fprofiles%3Fselect%3D*%23`,
  ],
];

describe('parseStorageObjectUrl — non-canonical paths (m14.3)', () => {
  it.each(VECTORS)('rejects %s', (_label, rest) => {
    expect(
      parseStorageObjectUrl(objectUrl(rest), { origin: ORIGIN })
    ).toBeNull();
    expect(parseStorageObjectUrl(objectUrl(rest))).toBeNull();
  });

  it('keeps the normalisation the input URL itself gets: a dot segment is resolved before the checks', () => {
    // `new URL` resolves `%2E`/`..` in the INPUT before we split it, so the
    // ref names the object fetch reaches, and ownership is checked on it.
    expect(parseStorageObjectUrl(objectUrl(`account-${A}/%2E/x.png`))).toEqual({
      bucket: 'chat-media',
      path: `account-${A}/x.png`,
    });
    expect(
      parseStorageObjectUrl(objectUrl(`account-${A}/%2e%2e/account-${B}/x.png`))
    ).toEqual({ bucket: 'chat-media', path: `account-${B}/x.png` });
  });

  it('rejects an encoded bucket segment', () => {
    expect(
      parseStorageObjectUrl(
        `${ORIGIN}/storage/v1/object/public/chat%2Dmedia/account-${A}/x.png`
      )
    ).toBeNull();
  });

  it('accepts the names buildMediaPath writes for uploads and the inbound mirror', () => {
    const names = [
      buildMediaPath(A, 'Factura Señor Pérez.PDF', 1_700_000_000_000),
      buildMediaPath(A, 'photo.final.v2.JPG', 1_700_000_000_000),
      buildMediaPath(A, 'README'),
      buildMediaPath(A, 'whatsapp-image-1234567890.jpg', null, 'inbound'),
      buildMediaPath(A, 'x.../../../account-b/y', 1),
    ];
    for (const path of names) {
      const ref = parseStorageObjectUrl(objectUrl(path), { origin: ORIGIN });
      expect(ref, path).toEqual({ bucket: 'chat-media', path });
    }
  });

  it('accepts legacy names with spaces, accents, dots and capitals', () => {
    const cases: [string, string][] = [
      [
        `account-${A}/inbound/Mi%20Factura%20N%C2%BA%203.pdf`,
        `account-${A}/inbound/Mi Factura Nº 3.pdf`,
      ],
      [
        `account-${A}/Se%C3%B1or.Pérez..v2.PNG`,
        `account-${A}/Señor.Pérez..v2.PNG`,
      ],
      [`${A}/1-..hidden`, `${A}/1-..hidden`],
      [`account-${A}/a%2Fb.png`, `account-${A}/a/b.png`],
    ];
    for (const [rest, path] of cases) {
      expect(parseStorageObjectUrl(objectUrl(rest))).toEqual({
        bucket: 'chat-media',
        path,
      });
    }
  });
});

describe('isCanonicalStoragePath', () => {
  it('requires the URL round trip to give back the same segments', () => {
    expect(isCanonicalStoragePath('chat-media', `account-${A}/a b é.png`)).toBe(
      true
    );
    expect(
      isCanonicalStoragePath('chat-media', `account-${A}/../account-${B}/x`)
    ).toBe(false);
    expect(isCanonicalStoragePath('chat-media', `account-${A}/.\t./x`)).toBe(
      false
    );
    expect(isCanonicalStoragePath('chat-media', `account-${A}/a\\b`)).toBe(
      false
    );
    expect(isCanonicalStoragePath('chat-media', `account-${A}/a?b`)).toBe(
      false
    );
    expect(isCanonicalStoragePath('chat-media', `account-${A}/a#b`)).toBe(
      false
    );
    expect(isCanonicalStoragePath('chat-media', `account-${A}/%2e%2e/x`)).toBe(
      false
    );
    expect(isCanonicalStoragePath('../rest', `account-${A}/x`)).toBe(false);
    expect(isCanonicalStoragePath('chat-media', '')).toBe(false);
  });
});

describe('assertStoragePathOwnedBy', () => {
  const ref = (path: string) => ({ bucket: 'chat-media', path });

  it('accepts exactly account-<A>/… for A', () => {
    expect(assertStoragePathOwnedBy(ref(`account-${A}/x.png`), A)).toEqual({
      kind: 'account',
    });
  });

  it('hands legacy <uid>/… paths back for a membership check', () => {
    expect(assertStoragePathOwnedBy(ref(`${B}/x.png`), A)).toEqual({
      kind: 'legacy',
      uid: B,
    });
  });

  it.each([
    ['another account', `account-${B}/x.png`, A],
    ['account-A as a prefix of account-AB', `account-${A}b/x.png`, A],
    ['a truncated id', `account-${A.slice(0, -1)}/x.png`, A],
    [
      'a non-UUID folder, even if it equals the account id',
      'account-acct-a/x.png',
      'acct-a',
    ],
    ['an empty account folder', 'account-/x.png', A],
    ['neither convention', 'inbound/x.png', A],
    ['a traversal built by hand', `account-${A}/../account-${B}/x.png`, A],
    ['a backslash built by hand', `account-${A}/..\\account-${B}\\x.png`, A],
  ])('refuses %s', (_label, path, accountId) => {
    expect(() => assertStoragePathOwnedBy(ref(path), accountId)).toThrow(
      StoragePathForbiddenError
    );
  });
});

describe('isOnOrigin', () => {
  it('compares origins only', () => {
    expect(isOnOrigin(objectUrl('x'), ORIGIN)).toBe(true);
    expect(isOnOrigin(`${ORIGIN}/rest/v1/x`, `${ORIGIN}/`)).toBe(true);
    expect(isOnOrigin('https://cdn.example.com/x', ORIGIN)).toBe(false);
    expect(isOnOrigin('not a url', ORIGIN)).toBe(false);
    expect(isOnOrigin(objectUrl('x'), undefined)).toBe(false);
  });
});
