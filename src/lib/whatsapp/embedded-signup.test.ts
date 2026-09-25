import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exchangeCodeForToken,
  generateRegistrationPin,
  refreshBusinessToken,
} from './embedded-signup';

// ---------------------------------------------------------------------------
// The code-for-token exchange (fase 4 §1). This is the one call in the
// feature that carries our app secret, so what it sends — and what it
// does with an answer that is not the happy one — is worth pinning.
// ---------------------------------------------------------------------------

const ARGS = {
  code: 'AQD-one-time-code',
  appId: 'app-123',
  appSecret: 'the-app-secret',
  graphVersion: 'v21.0',
};

let fetchMock: ReturnType<typeof vi.fn>;

function reply(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exchangeCodeForToken', () => {
  it('calls the oauth endpoint of the requested graph version with the three parameters', async () => {
    fetchMock.mockResolvedValue(reply({ access_token: 'EAAB-token' }));

    await exchangeCodeForToken(ARGS);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      'https://graph.facebook.com/v21.0/oauth/access_token'
    );
    expect(url.searchParams.get('client_id')).toBe('app-123');
    expect(url.searchParams.get('client_secret')).toBe('the-app-secret');
    expect(url.searchParams.get('code')).toBe('AQD-one-time-code');
    // Embedded Signup delivers the code through the JS SDK callback, not
    // a redirect. Sending a redirect_uri makes Meta reject the exchange.
    expect(url.searchParams.get('redirect_uri')).toBeNull();
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ method: 'GET' });
  });

  it('honours the graph version it is given', async () => {
    fetchMock.mockResolvedValue(reply({ access_token: 'EAAB-token' }));
    await exchangeCodeForToken({ ...ARGS, graphVersion: 'v23.0' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/v23.0/oauth/access_token'
    );
  });

  it('returns the token with a null expiry when Meta omits expires_in', async () => {
    // The normal case for a business-integration token: it does not
    // expire, so Meta does not say when it would.
    fetchMock.mockResolvedValue(reply({ access_token: 'EAAB-token' }));
    const result = await exchangeCodeForToken(ARGS);
    expect(result).toEqual({ accessToken: 'EAAB-token', expiresAt: null });
  });

  it('translates expires_in seconds into an ISO instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    fetchMock.mockResolvedValue(
      reply({ access_token: 'EAAB-token', expires_in: 3600 })
    );

    const result = await exchangeCodeForToken(ARGS);
    expect(result.expiresAt).toBe('2026-01-01T01:00:00.000Z');
    vi.useRealTimers();
  });

  it('treats a zero or negative expires_in as "no expiry"', async () => {
    fetchMock.mockResolvedValue(
      reply({ access_token: 'EAAB-token', expires_in: 0 })
    );
    expect((await exchangeCodeForToken(ARGS)).expiresAt).toBeNull();
  });

  it("propagates Meta's own error message", async () => {
    fetchMock.mockResolvedValue(
      reply(
        { error: { message: 'This authorization code has been used.' } },
        false,
        400
      )
    );
    await expect(exchangeCodeForToken(ARGS)).rejects.toThrow(
      'This authorization code has been used.'
    );
  });

  it('falls back to the status when the error body has no message', async () => {
    fetchMock.mockResolvedValue(reply({}, false, 500));
    await expect(exchangeCodeForToken(ARGS)).rejects.toThrow(
      'Meta API error: 500'
    );
  });

  it('tolerates a non-JSON body instead of throwing a parse error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    } as unknown as Response);

    await expect(exchangeCodeForToken(ARGS)).rejects.toThrow(
      'Meta API error: 502'
    );
  });

  it('rejects a 200 that carries no token', async () => {
    // Happens when the code was already redeemed — they are single use.
    fetchMock.mockResolvedValue(reply({ token_type: 'bearer' }));
    await expect(exchangeCodeForToken(ARGS)).rejects.toThrow(
      /single-use and short-lived/
    );
  });

  it('never puts the code or the secret in the thrown message', async () => {
    fetchMock.mockResolvedValue(
      reply(
        { error: { message: 'Invalid verification code format.' } },
        false,
        400
      )
    );
    const err = await exchangeCodeForToken(ARGS).catch((e: Error) => e);
    expect(String(err)).not.toContain(ARGS.code);
    expect(String(err)).not.toContain(ARGS.appSecret);
  });
});

describe('generateRegistrationPin', () => {
  it('always produces exactly six digits, zero-padded', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRegistrationPin()).toMatch(/^\d{6}$/);
    }
  });

  it('does not return the same PIN every time', () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => generateRegistrationPin())
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// The 60-day refresh (migration 067). Same endpoint, different grant:
// what goes on the wire is what Meta documents for expiring system-user
// tokens, and the failure handling is shared with the code exchange.
// ---------------------------------------------------------------------------

const REFRESH_ARGS = {
  accessToken: 'EAAB-current-token',
  appId: 'app-123',
  appSecret: 'the-app-secret',
  graphVersion: 'v21.0',
};

describe('refreshBusinessToken', () => {
  it('asks for fb_exchange_token with the 60-day flag and no code', async () => {
    fetchMock.mockResolvedValue(
      reply({ access_token: 'EAAB-fresh', expires_in: 5_184_000 })
    );

    await refreshBusinessToken(REFRESH_ARGS);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      'https://graph.facebook.com/v21.0/oauth/access_token'
    );
    expect(url.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(url.searchParams.get('client_id')).toBe('app-123');
    expect(url.searchParams.get('client_secret')).toBe('the-app-secret');
    expect(url.searchParams.get('fb_exchange_token')).toBe(
      'EAAB-current-token'
    );
    expect(url.searchParams.get('set_token_expires_in_60_days')).toBe('true');
    expect(url.searchParams.get('code')).toBeNull();
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ method: 'GET' });
  });

  it('returns the fresh token with its expiry as an ISO instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    fetchMock.mockResolvedValue(
      reply({ access_token: 'EAAB-fresh', expires_in: 60 * 24 * 60 * 60 })
    );

    const result = await refreshBusinessToken(REFRESH_ARGS);
    expect(result).toEqual({
      accessToken: 'EAAB-fresh',
      expiresAt: '2026-11-24T00:00:00.000Z',
    });
    vi.useRealTimers();
  });

  it("propagates Meta's message when the token can no longer be exchanged", async () => {
    fetchMock.mockResolvedValue(
      reply(
        {
          error: {
            message: 'Error validating access token: Session has expired',
          },
        },
        false,
        400
      )
    );
    await expect(refreshBusinessToken(REFRESH_ARGS)).rejects.toThrow(
      'Session has expired'
    );
  });

  it('rejects a 200 without a token with a refresh-specific message', async () => {
    fetchMock.mockResolvedValue(reply({ token_type: 'bearer' }));
    await expect(refreshBusinessToken(REFRESH_ARGS)).rejects.toThrow(
      /reconnect the number/
    );
  });

  it('never puts the current token or the secret in the thrown message', async () => {
    fetchMock.mockResolvedValue(
      reply({ error: { message: 'Invalid OAuth access token.' } }, false, 400)
    );
    let thrown: unknown;
    try {
      await refreshBusinessToken(REFRESH_ARGS);
    } catch (err) {
      thrown = err;
    }
    const text = String((thrown as Error).message);
    expect(text).not.toContain('EAAB-current-token');
    expect(text).not.toContain('the-app-secret');
  });
});
