import { beforeEach, describe, expect, it, vi } from 'vitest';

// The support-session token: what it takes to be honoured, and the far
// longer list of what makes it worthless. Everything here is the
// mechanism that stops impersonation from being a back door — a forged
// or replayed cookie must grant nothing at all.

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  /** Users currently in `platform_admins`. */
  admins: new Set<string>(),
  lookups: [] as string[],
  throwOnCookies: false,
  /** Bitácora rows that are still open (`logId`s). */
  openRows: new Set<string>(),
  rowLookups: [] as string[],
}));

vi.mock('next/headers', () => ({
  cookies: async () => {
    if (h.throwOnCookies) throw new Error('called outside a request scope');
    return {
      get: (name: string) =>
        h.cookies.has(name) ? { name, value: h.cookies.get(name) } : undefined,
      set: (name: string, value: string) => h.cookies.set(name, value),
      delete: (name: string) => h.cookies.delete(name),
    };
  },
}));

vi.mock('./platform-admins', () => ({
  isPlatformAdmin: async (userId: string) => {
    h.lookups.push(userId);
    return h.admins.has(userId);
  },
}));

// The bitácora row is the session; the cookie only claims one exists.
vi.mock('./support-session-store', () => ({
  isSupportSessionOpen: async (s: { logId: string }) => {
    h.rowLookups.push(s.logId);
    return h.openRows.has(s.logId);
  },
}));

const {
  MIN_REASON_LENGTH,
  SUPPORT_COOKIE,
  SUPPORT_SESSION_TTL_MS,
  clearSupportCookie,
  readSupportCookie,
  resolveSupportSession,
  setSupportCookie,
  signSupportSession,
  verifySupportSession,
} = await import('./impersonation');

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TARGET = 'aaaaaaaa-0000-4000-8000-000000000001';

function session(
  overrides: Partial<Parameters<typeof signSupportSession>[0]> = {}
) {
  return {
    logId: 'log-1',
    actorUserId: ACTOR,
    accountId: TARGET,
    expiresAt: Date.now() + SUPPORT_SESSION_TTL_MS,
    ...overrides,
  };
}

beforeEach(() => {
  h.cookies.clear();
  h.admins.clear();
  h.lookups = [];
  h.throwOnCookies = false;
  h.openRows = new Set(['log-1']);
  h.rowLookups = [];
});

describe('signSupportSession / verifySupportSession', () => {
  it('round-trips a session it signed itself', () => {
    const s = session();
    expect(verifySupportSession(signSupportSession(s))).toEqual(s);
  });

  it('rejects a payload edited after signing', () => {
    // The whole attack this guards: swap the account id for a richer
    // customer's and keep the signature.
    const token = signSupportSession(session());
    const [, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify(
        session({ accountId: 'bbbbbbbb-0000-4000-8000-000000000002' })
      ),
      'utf8'
    ).toString('base64url');

    expect(verifySupportSession(`${forged}.${mac}`)).toBeNull();
  });

  it('rejects a deadline pushed into the future by hand', () => {
    const token = signSupportSession(session());
    const [, mac] = token.split('.');
    const extended = Buffer.from(
      JSON.stringify(
        session({ expiresAt: Date.now() + 10 * 365 * 24 * 3600_000 })
      ),
      'utf8'
    ).toString('base64url');

    expect(verifySupportSession(`${extended}.${mac}`)).toBeNull();
  });

  it('rejects a truncated signature instead of throwing', () => {
    // timingSafeEqual throws on a length mismatch; a snipped cookie must
    // be a "no", not a 500 on every request that carries it.
    const token = signSupportSession(session());
    const [payload, mac] = token.split('.');
    expect(() =>
      verifySupportSession(`${payload}.${mac.slice(0, 10)}`)
    ).not.toThrow();
    expect(verifySupportSession(`${payload}.${mac.slice(0, 10)}`)).toBeNull();
  });

  it('rejects garbage, empty strings and the wrong number of parts', () => {
    expect(verifySupportSession('')).toBeNull();
    expect(verifySupportSession('not-a-token')).toBeNull();
    expect(verifySupportSession('a.b.c')).toBeNull();
  });

  it('rejects a session whose deadline has passed', () => {
    const expired = signSupportSession(session({ expiresAt: Date.now() - 1 }));
    expect(verifySupportSession(expired)).toBeNull();
  });

  it('still verifies an expired token when asked against an earlier clock', () => {
    // How the routes tell "expired, close its bitácora row" apart from
    // "forged, ignore it".
    const expired = signSupportSession(session({ expiresAt: 1000 }));
    expect(verifySupportSession(expired)).toBeNull();
    expect(verifySupportSession(expired, 0)?.accountId).toBe(TARGET);
  });

  it('is signed with a key derived from ENCRYPTION_KEY, not the key itself', () => {
    // Rotating ENCRYPTION_KEY invalidates open support sessions, which is
    // the correct direction to fail. A token must not survive it.
    const token = signSupportSession(session());
    vi.stubEnv('ENCRYPTION_KEY', '1'.repeat(64));
    expect(verifySupportSession(token)).toBeNull();
    vi.unstubAllEnvs();
    expect(verifySupportSession(token)).not.toBeNull();
  });

  it('fails closed when ENCRYPTION_KEY is missing or malformed', () => {
    const token = signSupportSession(session());
    vi.stubEnv('ENCRYPTION_KEY', 'not-hex');
    expect(verifySupportSession(token)).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe('cookie plumbing', () => {
  it('writes the token under the support cookie and clears it again', async () => {
    await setSupportCookie('token-value', Date.now() + SUPPORT_SESSION_TTL_MS);
    expect(h.cookies.get(SUPPORT_COOKIE)).toBe('token-value');
    expect(await readSupportCookie()).toBe('token-value');

    await clearSupportCookie();
    expect(h.cookies.has(SUPPORT_COOKIE)).toBe(false);
    expect(await readSupportCookie()).toBeNull();
  });

  it('reads no cookie outside a request scope instead of throwing', async () => {
    // Imported by modules that also run in background work; `cookies()`
    // throwing there means "no support session", not a crash.
    h.throwOnCookies = true;
    await expect(readSupportCookie()).resolves.toBeNull();
  });
});

describe('resolveSupportSession', () => {
  it('resolves for the platform admin who opened it', async () => {
    h.admins.add(ACTOR);
    h.cookies.set(SUPPORT_COOKIE, signSupportSession(session()));

    const resolved = await resolveSupportSession(ACTOR);
    expect(resolved?.accountId).toBe(TARGET);
  });

  it('returns null with no cookie, and never asks the database', async () => {
    h.admins.add(ACTOR);
    expect(await resolveSupportSession(ACTOR)).toBeNull();
    expect(h.lookups).toEqual([]);
  });

  it('refuses a cookie copied into another user’s browser', async () => {
    h.admins.add(ACTOR);
    h.admins.add(OTHER);
    h.cookies.set(SUPPORT_COOKIE, signSupportSession(session()));

    // OTHER is a platform admin too — and still cannot use a session
    // signed for ACTOR.
    expect(await resolveSupportSession(OTHER)).toBeNull();
  });

  it('refuses once the actor is no longer a platform admin', async () => {
    h.cookies.set(SUPPORT_COOKIE, signSupportSession(session()));
    // Not in platform_admins: revoking the grant ends sessions already
    // open, without having to hunt down cookies.
    expect(await resolveSupportSession(ACTOR)).toBeNull();
    expect(h.lookups).toEqual([ACTOR]);
  });

  it('refuses an expired cookie even for the right admin', async () => {
    h.admins.add(ACTOR);
    h.cookies.set(
      SUPPORT_COOKIE,
      signSupportSession(session({ expiresAt: Date.now() - 1 }))
    );
    expect(await resolveSupportSession(ACTOR)).toBeNull();
  });

  // ----------------------------------------------------------------
  // Revocation. `httpOnly` keeps a cookie away from other sites, not
  // from its own holder: the operator can read the token out of devtools
  // or a proxy. If pressing "exit" only cleared the browser's copy, the
  // token itself would stay valid for the rest of its 30 minutes — and
  // the bitácora would already say the session ended. That is
  // impersonation that is not recorded, which is the one outcome this
  // feature exists to prevent.
  // ----------------------------------------------------------------

  it('refuses a cookie put back after stop — the closed row revokes it', async () => {
    h.admins.add(ACTOR);
    const token = signSupportSession(session());
    h.cookies.set(SUPPORT_COOKIE, token);
    expect(await resolveSupportSession(ACTOR)).not.toBeNull();

    // `POST /stop` closes the row. The operator pastes the cookie back.
    h.openRows.delete('log-1');
    h.cookies.set(SUPPORT_COOKIE, token);

    expect(await resolveSupportSession(ACTOR)).toBeNull();
  });

  it('asks about the row named by the cookie, not one from a request', async () => {
    h.admins.add(ACTOR);
    h.openRows.add('log-9');
    h.cookies.set(
      SUPPORT_COOKIE,
      signSupportSession(session({ logId: 'log-9' }))
    );

    await resolveSupportSession(ACTOR);
    expect(h.rowLookups).toEqual(['log-9']);
  });

  it('does not query the bitácora for a cookie that already failed', async () => {
    // Cheap path first: a forged or foreign cookie costs no round trip.
    h.admins.add(ACTOR);
    h.cookies.set(SUPPORT_COOKIE, 'not.a.token');
    expect(await resolveSupportSession(ACTOR)).toBeNull();
    expect(h.rowLookups).toEqual([]);
  });
});

describe('MIN_REASON_LENGTH', () => {
  it('matches the CHECK constraint in migration 055', () => {
    // The route and the database have to agree, or a reason the API
    // accepts blows up as a 500 on insert.
    expect(MIN_REASON_LENGTH).toBe(10);
  });
});
