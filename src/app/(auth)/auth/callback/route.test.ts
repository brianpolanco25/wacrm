import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * s9.8 — GET /auth/callback over a mocked SSR client: the redirect it
 * answers with, on the host the request came in on, never cacheable.
 */

const h = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: h.exchangeCodeForSession,
      verifyOtp: h.verifyOtp,
    },
  }),
}));

import { GET } from './route';

beforeEach(() => {
  h.exchangeCodeForSession.mockResolvedValue({
    data: { redirectType: null },
    error: null,
  });
  h.verifyOtp.mockResolvedValue({ data: {}, error: null });
});

async function get(path: string) {
  const res = await GET(new NextRequest(`https://app.test${path}`));
  return { res, location: res.headers.get('location') };
}

describe('GET /auth/callback', () => {
  it('code → exchanged, 307 to the dashboard, private', async () => {
    const { res, location } = await get('/auth/callback?code=c1');
    expect(res.status).toBe(307);
    expect(location).toBe('/dashboard');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.exchangeCodeForSession).toHaveBeenCalledWith('c1');
  });

  it('token_hash invite → /reset-password carrying the invite', async () => {
    const { location } = await get(
      '/auth/callback?token_hash=h1&type=invite&invite=tok'
    );
    expect(location).toBe('/reset-password?invite=tok&welcome=1');
    expect(h.verifyOtp).toHaveBeenCalledWith({
      token_hash: 'h1',
      type: 'invite',
    });
  });

  it('nothing → the browser page, which will read the fragment', async () => {
    const { location } = await get('/auth/callback?next=%2Freset-password');
    expect(location).toBe('/auth/callback/complete?next=%2Freset-password');
    expect(h.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(h.verifyOtp).not.toHaveBeenCalled();
  });

  it('expired link → the browser page with the error', async () => {
    h.verifyOtp.mockResolvedValue({
      data: {},
      error: { code: 'otp_expired' },
    });
    const { location } = await get(
      '/auth/callback?token_hash=h1&type=recovery'
    );
    expect(location).toBe('/auth/callback/complete?error_code=otp_expired');
  });

  it('an absolute next never leaves the host', async () => {
    const { location } = await get(
      '/auth/callback?code=c1&next=https%3A%2F%2Fevil.test%2Fx'
    );
    expect(location).toBe('/dashboard');
  });

  // Review of s9.8: dot segments and encodings that normalise to
  // `//evil.com`. Encoded in the query, as an attacker would send them.
  const VECTORS = [
    '//evil.com',
    'https://evil.com',
    '/\\evil.com',
    '%2F%2Fevil.com',
    '/%2F%2Fevil.com',
    '/.//evil.com',
    '/..//evil.com',
    '/%2e//evil.com',
    '/a/..//evil.com',
  ];

  it.each(VECTORS)('code + next=%s → /dashboard, relative', async (next) => {
    const { location } = await get(
      `/auth/callback?code=c1&next=${encodeURIComponent(next)}`
    );
    expect(location).toBe('/dashboard');
  });

  it.each(VECTORS)(
    'no code + next=%s → the browser page WITHOUT that next',
    async (next) => {
      const { location } = await get(
        `/auth/callback?next=${encodeURIComponent(next)}`
      );
      expect(location).toBe('/auth/callback/complete');
    }
  );

  // Review of s9.8 (third round): in a Route Handler `request.nextUrl`
  // is the address the server listens on, not the one the browser used.
  // An absolute Location built from it sent every email link to
  // localhost behind the proxy. The answer is relative, whatever the
  // request's own URL or Host / X-Forwarded-* headers say.
  it.each([
    ['code=c1', '/dashboard'],
    [
      'next=%2Freset-password',
      '/auth/callback/complete?next=%2Freset-password',
    ],
  ])(
    'relative Location, independent of the listening host (%s)',
    async (qs, expected) => {
      const res = await GET(
        new NextRequest(`http://localhost:3000/auth/callback?${qs}`, {
          headers: {
            host: 'crm.example.com',
            'x-forwarded-host': 'crm.example.com',
            'x-forwarded-proto': 'https',
          },
        })
      );
      const location = res.headers.get('location');
      expect(res.status).toBe(307);
      expect(location).toBe(expected);
      expect(location).not.toContain('localhost');
      expect(location).not.toContain('://');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
  );
});
