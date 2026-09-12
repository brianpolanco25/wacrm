import { beforeEach, describe, expect, it, vi } from 'vitest';

// What the dashboard shell asks before painting the impersonation banner.
// Two properties matter more than the happy path: it must not cost a query
// when nobody is impersonating anything, and it must still render — with
// the exit button — when the thing it is warning about has broken.

const h = vi.hoisted(() => ({
  cookie: null as string | null,
  /** What `getCurrentAccount()` does: a context, or a thrown error. */
  context: null as unknown,
  contextError: null as unknown,
  /** What `resolveSupportSession` says for the authenticated user. */
  session: null as { accountId: string; expiresAt: number } | null,
  user: null as { id: string } | null,
  calls: [] as string[],
}));

vi.mock('./impersonation', () => ({
  readSupportCookie: async () => {
    h.calls.push('cookie');
    return h.cookie;
  },
  resolveSupportSession: async () => {
    h.calls.push('resolve');
    return h.session;
  },
}));

vi.mock('./account', () => ({
  getCurrentAccount: async () => {
    h.calls.push('account');
    if (h.contextError) throw h.contextError;
    return h.context;
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
  }),
}));

const { supportBanner } = await import('./support-view');

const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const EXPIRES = Date.parse('2026-01-01T00:30:00.000Z');

beforeEach(() => {
  h.cookie = null;
  h.context = null;
  h.contextError = null;
  h.session = null;
  h.user = { id: 'operator-1' };
  h.calls = [];
});

describe('supportBanner', () => {
  it('costs nothing when there is no support cookie', async () => {
    expect(await supportBanner()).toBeNull();
    // It sits in the layout of every dashboard page: the normal path has
    // to stop at the cookie.
    expect(h.calls).toEqual(['cookie']);
  });

  it('reports the impersonated account and its deadline', async () => {
    h.cookie = 'signed.token';
    h.context = {
      accountId: ACCOUNT,
      account: { id: ACCOUNT, name: 'Acme Foods' },
      impersonation: { expiresAt: EXPIRES },
    };

    expect(await supportBanner()).toEqual({
      accountId: ACCOUNT,
      accountName: 'Acme Foods',
      expiresAt: '2026-01-01T00:30:00.000Z',
    });
  });

  it('says nothing when the cookie grants no session', async () => {
    // Somebody else's cookie, left in a shared browser: not a session, so
    // not a banner.
    h.cookie = 'signed.token';
    h.context = {
      accountId: 'own',
      account: { name: 'Mine' },
      impersonation: null,
    };

    expect(await supportBanner()).toBeNull();
  });

  it('still announces a session whose account cannot be read', async () => {
    // Deleted mid-session. Without this the operator keeps a read-only
    // dashboard with no banner and no way out for the rest of the window.
    h.cookie = 'signed.token';
    h.contextError = new Error('The impersonated account no longer exists');
    h.session = { accountId: ACCOUNT, expiresAt: EXPIRES };

    expect(await supportBanner()).toEqual({
      accountId: ACCOUNT,
      accountName: null,
      expiresAt: '2026-01-01T00:30:00.000Z',
    });
  });

  it('does not invent a banner for a failure that is not a session', async () => {
    // A broken profile of the operator's own throws the same way; there is
    // no support session behind it, so there is nothing to announce.
    h.cookie = 'stale.token';
    h.contextError = new Error('Profile is not linked to an account');
    h.session = null;

    expect(await supportBanner()).toBeNull();
  });

  it('never throws, even when the fallback cannot find a user', async () => {
    h.cookie = 'signed.token';
    h.contextError = new Error('Unauthorized');
    h.user = null;

    await expect(supportBanner()).resolves.toBeNull();
  });
});
