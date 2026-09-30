import { describe, expect, it, vi } from 'vitest';

import {
  callbackErrorReason,
  completeAuthCallback,
  parseAuthFragment,
  resolveCallback,
} from './callback';

/**
 * s9.8 — the three shapes a Supabase Auth link can take (PKCE `code`,
 * `token_hash` + `type`, implicit-flow fragment) and the errors, on both
 * halves of /auth/callback. The auth clients are stubs; what is under
 * test is which call is made and where the person is sent.
 */

type ServerAuth = Parameters<typeof resolveCallback>[1];
type BrowserAuth = Parameters<typeof completeAuthCallback>[0]['auth'];

function serverAuth(opts: {
  exchange?: { redirectType?: string | null; error?: { code?: string } };
  verify?: { error?: { code?: string } };
}) {
  const exchangeCodeForSession = vi.fn(async () => ({
    data: { redirectType: opts.exchange?.redirectType ?? null },
    error: opts.exchange?.error ?? null,
  }));
  const verifyOtp = vi.fn(async () => ({
    data: {},
    error: opts.verify?.error ?? null,
  }));
  return {
    auth: { exchangeCodeForSession, verifyOtp } as unknown as ServerAuth,
    exchangeCodeForSession,
    verifyOtp,
  };
}

const q = (s: string) => new URLSearchParams(s);

describe('resolveCallback — server half', () => {
  it('exchanges a PKCE code and goes to the default place', async () => {
    const s = serverAuth({});
    expect(await resolveCallback(q('code=c1'), s.auth)).toBe('/dashboard');
    expect(s.exchangeCodeForSession).toHaveBeenCalledWith('c1');
    expect(s.verifyOtp).not.toHaveBeenCalled();
  });

  it('a recovery code (redirectType) goes to /reset-password', async () => {
    const s = serverAuth({ exchange: { redirectType: 'recovery' } });
    expect(await resolveCallback(q('code=c1'), s.auth)).toBe('/reset-password');
  });

  it('a sign-up code with ?invite= goes to /join/<token>', async () => {
    const s = serverAuth({});
    expect(await resolveCallback(q('code=c1&invite=tok'), s.auth)).toBe(
      '/join/tok'
    );
  });

  it('verifies a token_hash invite and goes to /reset-password', async () => {
    const s = serverAuth({});
    expect(
      await resolveCallback(q('token_hash=h1&type=invite&invite=tok'), s.auth)
    ).toBe('/reset-password?invite=tok&welcome=1');
    expect(s.verifyOtp).toHaveBeenCalledWith({
      token_hash: 'h1',
      type: 'invite',
    });
    expect(s.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('verifies a token_hash recovery', async () => {
    const s = serverAuth({});
    expect(
      await resolveCallback(q('token_hash=h1&type=recovery'), s.auth)
    ).toBe('/reset-password');
  });

  it('a token_hash signup / email lands on the safe next or the default', async () => {
    const s = serverAuth({});
    expect(await resolveCallback(q('token_hash=h&type=signup'), s.auth)).toBe(
      '/dashboard'
    );
    expect(
      await resolveCallback(q('token_hash=h&type=email&next=/inbox'), s.auth)
    ).toBe('/inbox');
    expect(
      await resolveCallback(
        q('token_hash=h&type=email&next=https://evil.test'),
        s.auth
      )
    ).toBe('/dashboard');
  });

  it('refuses a token_hash with an unknown type without calling Supabase', async () => {
    const s = serverAuth({});
    expect(await resolveCallback(q('token_hash=h&type=bogus'), s.auth)).toBe(
      '/auth/callback/complete?error_code=invalid'
    );
    expect(s.verifyOtp).not.toHaveBeenCalled();
  });

  it('an expired token_hash goes to the error page, keeping next/invite', async () => {
    const s = serverAuth({ verify: { error: { code: 'otp_expired' } } });
    expect(
      await resolveCallback(
        q('token_hash=h&type=invite&next=/reset-password&invite=tok'),
        s.auth
      )
    ).toBe(
      '/auth/callback/complete?next=%2Freset-password&invite=tok&error_code=otp_expired'
    );
  });

  it('a code without its verifier (other browser) goes to the error page', async () => {
    const s = serverAuth({
      exchange: { error: { code: 'pkce_code_verifier_not_found' } },
    });
    expect(await resolveCallback(q('code=c'), s.auth)).toBe(
      '/auth/callback/complete?error_code=pkce_code_verifier_not_found'
    );
  });

  it('an error Supabase put in the query is forwarded without any call', async () => {
    const s = serverAuth({});
    expect(
      await resolveCallback(
        q('error=access_denied&error_code=otp_expired&error_description=x'),
        s.auth
      )
    ).toBe('/auth/callback/complete?error_code=otp_expired');
    expect(s.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(s.verifyOtp).not.toHaveBeenCalled();
  });

  it('nothing in the query → the browser page (the fragment rides along)', async () => {
    const s = serverAuth({});
    expect(
      await resolveCallback(q('next=/reset-password&invite=tok'), s.auth)
    ).toBe('/auth/callback/complete?next=%2Freset-password&invite=tok');
    expect(await resolveCallback(q(''), s.auth)).toBe(
      '/auth/callback/complete'
    );
  });
});

describe('parseAuthFragment', () => {
  it('reads the implicit-flow tokens and type', () => {
    expect(
      parseAuthFragment(
        '#access_token=at&expires_in=3600&refresh_token=rt&token_type=bearer&type=invite'
      )
    ).toEqual({
      kind: 'tokens',
      accessToken: 'at',
      refreshToken: 'rt',
      type: 'invite',
    });
  });

  it('reads an error', () => {
    expect(
      parseAuthFragment(
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
      )
    ).toEqual({ kind: 'error', code: 'otp_expired' });
  });

  it('nothing usable', () => {
    expect(parseAuthFragment('')).toEqual({ kind: 'none' });
    expect(parseAuthFragment('#access_token=only')).toEqual({ kind: 'none' });
  });
});

describe('callbackErrorReason', () => {
  it.each([
    ['otp_expired', 'expired'],
    ['flow_state_expired', 'expired'],
    ['pkce_code_verifier_not_found', 'otherBrowser'],
    ['bad_code_verifier', 'otherBrowser'],
    ['missing', 'missing'],
    ['whatever', 'invalid'],
    [undefined, 'invalid'],
  ])('%s → %s', (code, reason) => {
    expect(callbackErrorReason(code)).toBe(reason);
  });
});

function browserAuth(opts: {
  setSessionError?: { code?: string };
  user?: { id: string } | null;
}) {
  const setSession = vi.fn(async () => ({
    data: {},
    error: opts.setSessionError ?? null,
  }));
  const getUser = vi.fn(async () => ({
    data: { user: opts.user ?? null },
    error: null,
  }));
  return {
    auth: { setSession, getUser } as unknown as BrowserAuth,
    setSession,
    getUser,
  };
}

const TOKENS =
  '#access_token=at&refresh_token=rt&expires_in=3600&token_type=bearer';

describe('completeAuthCallback — browser half', () => {
  it('opens the session from the fragment and sends an invite to /reset-password', async () => {
    const b = browserAuth({});
    const fetchImpl = vi.fn();
    const result = await completeAuthCallback({
      hash: `${TOKENS}&type=invite`,
      search: '?next=/reset-password&invite=tok',
      auth: b.auth,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(b.setSession).toHaveBeenCalledWith({
      access_token: 'at',
      refresh_token: 'rt',
    });
    expect(result).toEqual({
      ok: true,
      destination: '/reset-password?invite=tok&welcome=1',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a fragment recovery also goes to /reset-password', async () => {
    const b = browserAuth({});
    expect(
      await completeAuthCallback({
        hash: `${TOKENS}&type=recovery`,
        search: '',
        auth: b.auth,
      })
    ).toEqual({ ok: true, destination: '/reset-password' });
  });

  it('a fragment magic link without next asks postLoginDestination (operator → /platform)', async () => {
    const b = browserAuth({});
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(
      await completeAuthCallback({
        hash: `${TOKENS}&type=magiclink`,
        search: '',
        auth: b.auth,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).toEqual({ ok: true, destination: '/platform' });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/platform/me',
      expect.anything()
    );
  });

  it('an error in the fragment (expired link) → expired, no session call', async () => {
    const b = browserAuth({});
    expect(
      await completeAuthCallback({
        hash: '#error=access_denied&error_code=otp_expired&error_description=x',
        search: '',
        auth: b.auth,
      })
    ).toEqual({ ok: false, reason: 'expired' });
    expect(b.setSession).not.toHaveBeenCalled();
  });

  it('an error the server forwarded in the query wins over everything', async () => {
    const b = browserAuth({ user: { id: 'u' } });
    expect(
      await completeAuthCallback({
        hash: TOKENS,
        search: '?error_code=pkce_code_verifier_not_found',
        auth: b.auth,
      })
    ).toEqual({ ok: false, reason: 'otherBrowser' });
    expect(b.setSession).not.toHaveBeenCalled();
  });

  it('setSession refusing the tokens → error', async () => {
    const b = browserAuth({
      setSessionError: { code: 'refresh_token_already_used' },
    });
    expect(
      await completeAuthCallback({ hash: TOKENS, search: '', auth: b.auth })
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('no fragment but a session already open → carries on', async () => {
    const b = browserAuth({ user: { id: 'u' } });
    expect(
      await completeAuthCallback({
        hash: '',
        search: '?invite=tok',
        auth: b.auth,
      })
    ).toEqual({ ok: true, destination: '/join/tok' });
    expect(b.setSession).not.toHaveBeenCalled();
  });

  it('nothing at all and no session → missing', async () => {
    const b = browserAuth({ user: null });
    expect(
      await completeAuthCallback({ hash: '', search: '', auth: b.auth })
    ).toEqual({ ok: false, reason: 'missing' });
  });
});
