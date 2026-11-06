import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// m14.1 (A1) — GET /api/media/sign?url=<stored media_url>
//
//   401 without a user
//   400 for a URL that is not a media object of THIS project
//   403 for an object outside `account-<effective account>/`
//   200 in a support session: signs the impersonated account's object
//       with the service role for SIGNED_URL_TTL_SECONDS
// ---------------------------------------------------------------------------

const ORIGIN = 'https://proj.supabase.co';
const OPERATOR = 'user-operator';
const OWN = 'acct-operator';
const TARGET = 'acct-target';

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  effective: null as string | null,
  signs: [] as { bucket: string; path: string; ttl: number }[],
  signError: null as { message: string } | null,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        h.user
          ? { data: { user: h.user }, error: null }
          : { data: { user: null }, error: { message: 'no session' } },
    },
  }),
}));

vi.mock('@/lib/auth/account', () => ({
  resolveEffectiveAccountId: async (_supabase: unknown, userId: string) =>
    userId === OPERATOR ? h.effective : null,
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number) => {
          h.signs.push({ bucket, path, ttl });
          if (h.signError) return { data: null, error: h.signError };
          return {
            data: {
              signedUrl: `${ORIGIN}/storage/v1/object/sign/${bucket}/${path}?token=svc`,
            },
            error: null,
          };
        },
      }),
    },
  }),
}));

import { GET } from './route';
import { SIGNED_URL_TTL_SECONDS } from '@/lib/media/signed-url';

const obj = (path: string, bucket = 'chat-media', origin = ORIGIN) =>
  `${origin}/storage/v1/object/public/${bucket}/${path}`;

function sign(url: string) {
  return GET(
    new Request(
      `https://crm.example.com/api/media/sign?url=${encodeURIComponent(url)}`
    )
  );
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  h.user = { id: OPERATOR };
  // A support session: the effective account is the impersonated one.
  h.effective = TARGET;
  h.signs = [];
  h.signError = null;
});

describe('GET /api/media/sign', () => {
  it('401s without an authenticated user, and signs nothing', async () => {
    h.user = null;
    const res = await sign(obj(`account-${TARGET}/1-photo.png`));
    expect(res.status).toBe(401);
    expect(h.signs).toEqual([]);
  });

  it('400s a URL on another host, outside the media buckets, or not a storage URL', async () => {
    for (const url of [
      obj(`account-${TARGET}/1-photo.png`, 'chat-media', 'https://evil.co'),
      obj(`account-${TARGET}/1-photo.png`, 'avatars'),
      'https://cdn.example.com/x.png',
      '/api/whatsapp/media/123',
      '',
    ]) {
      const res = await sign(url);
      expect(res.status, url).toBe(400);
    }
    expect(h.signs).toEqual([]);
  });

  it('400s when the project origin is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const res = await sign(obj(`account-${TARGET}/1-photo.png`));
    expect(res.status).toBe(400);
    expect(h.signs).toEqual([]);
  });

  it("403s an object of another account — including the operator's own company in a support session", async () => {
    for (const path of [
      `account-${OWN}/1-photo.png`,
      `account-other/1-photo.png`,
      `account-${TARGET}x/1-photo.png`,
      // Legacy pre-020 `<uid>/…` paths are never interpreted here.
      '11111111-1111-4111-8111-111111111111/1-photo.png',
      // Dot segments smuggled in percent-encoded slashes.
      `account-${TARGET}%2F..%2Faccount-other/1-photo.png`,
    ]) {
      const res = await sign(obj(path));
      expect(res.status, path).toBe(403);
    }
    expect(h.signs).toEqual([]);
  });

  it('403s a user without an effective account', async () => {
    h.effective = null;
    const res = await sign(obj(`account-${TARGET}/1-photo.png`));
    expect(res.status).toBe(403);
    expect(h.signs).toEqual([]);
  });

  it("200s in a support session: signs the impersonated account's object with the service role", async () => {
    const before = Date.now();
    const res = await sign(obj(`account-${TARGET}/1-photo.png`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    expect(h.signs).toEqual([
      {
        bucket: 'chat-media',
        path: `account-${TARGET}/1-photo.png`,
        ttl: SIGNED_URL_TTL_SECONDS,
      },
    ]);
    expect(body.url).toBe(
      `${ORIGIN}/storage/v1/object/sign/chat-media/account-${TARGET}/1-photo.png?token=svc`
    );
    expect(body.expiresAt).toBeGreaterThanOrEqual(
      before + SIGNED_URL_TTL_SECONDS * 1000
    );
    expect(body.expiresAt).toBeLessThanOrEqual(
      Date.now() + SIGNED_URL_TTL_SECONDS * 1000
    );
  });

  it('signs flow-media objects too', async () => {
    const res = await sign(obj(`account-${TARGET}/node.png`, 'flow-media'));
    expect(res.status).toBe(200);
    expect(h.signs[0].bucket).toBe('flow-media');
  });

  it('502s when storage refuses to sign (missing object), without leaking the error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.signError = { message: 'Object not found' };
    const res = await sign(obj(`account-${TARGET}/gone.png`));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('Object not found');
  });
});
