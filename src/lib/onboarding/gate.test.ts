import { beforeEach, describe, expect, it, vi } from 'vitest';

// s9.6: the onboarding gate the dashboard layout applies. Who is sent to
// /onboarding, who to /platform, and who goes straight in.

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadOnboardingState: vi.fn(),
  isPlatformAdmin: vi.fn(),
  /** What the middleware put in `x-wacrm-pathname`. */
  path: '/dashboard' as string | null,
  /** The company columns the real state reads (service role, mocked). */
  account: {} as Record<string, unknown>,
  getEntitlements: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers(h.path === null ? {} : { 'x-wacrm-pathname': h.path }),
}));
// Only reached by the tests that run the REAL loadOnboardingState.
vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => {
    const chain = {
      select: () => chain,
      update: () => chain,
      eq: () => chain,
      is: () => chain,
      maybeSingle: async () => ({ data: h.account, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null }),
    };
    return { from: () => chain };
  },
}));
vi.mock('@/lib/billing/enforce', () => ({
  getEntitlements: h.getEntitlements,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: h.getCurrentAccount,
}));
vi.mock('./state', () => ({ loadOnboardingState: h.loadOnboardingState }));
vi.mock('@/lib/auth/platform-admins', () => ({
  isPlatformAdmin: h.isPlatformAdmin,
}));
// `cache()` is per request in React's server build; in a test each call
// has to run for real.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}));

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { onboardingRedirect } from './gate';

const CTX = {
  userId: 'user-1',
  accountId: 'acct-1',
  role: 'owner',
  account: { id: 'acct-1', name: 'Acme' },
  impersonation: null,
};

beforeEach(() => {
  h.path = '/dashboard';
  h.account = {
    id: 'acct-1',
    name: 'Acme',
    country: null,
    phone: null,
    industry: null,
    team_size: null,
    onboarding_completed_at: null,
  };
  h.getEntitlements.mockReset();
  h.getCurrentAccount.mockReset().mockResolvedValue(CTX);
  h.loadOnboardingState.mockReset();
  h.isPlatformAdmin.mockReset().mockResolvedValue(false);
});

describe('onboardingRedirect', () => {
  it.each(['company', 'plan'])(
    'sends an account on the %s step to /onboarding',
    async (step) => {
      h.loadOnboardingState.mockResolvedValue({ step, status: 'incomplete' });
      await expect(onboardingRedirect()).resolves.toBe('/onboarding');
      expect(h.loadOnboardingState).toHaveBeenCalledWith(CTX);
    }
  );

  it('lets an active account in (and does not even ask about operators)', async () => {
    h.loadOnboardingState.mockResolvedValue({ step: 'done', status: 'active' });
    await expect(onboardingRedirect()).resolves.toBeNull();
    expect(h.isPlatformAdmin).not.toHaveBeenCalled();
  });

  it('lets a manual plan in (s9.4): the state says done', async () => {
    h.loadOnboardingState.mockResolvedValue({ step: 'done', status: 'active' });
    await expect(onboardingRedirect()).resolves.toBeNull();
  });

  it('sends a platform operator whose own company is unpaid to /platform, not /onboarding', async () => {
    h.loadOnboardingState.mockResolvedValue({
      step: 'company',
      status: 'incomplete',
    });
    h.isPlatformAdmin.mockResolvedValue(true);
    await expect(onboardingRedirect()).resolves.toBe('/platform');
    expect(h.isPlatformAdmin).toHaveBeenCalledWith('user-1');
  });

  it('never gates a support session: the operator sees the customer as they are', async () => {
    h.getCurrentAccount.mockResolvedValue({
      ...CTX,
      role: 'admin',
      impersonation: { accountId: 'acct-1', expiresAt: Date.now() + 60_000 },
    });
    await expect(onboardingRedirect()).resolves.toBeNull();
    expect(h.loadOnboardingState).not.toHaveBeenCalled();
  });

  it('leaves the signed-out and the unlinked to the shell (no redirect loop)', async () => {
    h.getCurrentAccount.mockRejectedValueOnce(new UnauthorizedError());
    await expect(onboardingRedirect()).resolves.toBeNull();
    h.getCurrentAccount.mockRejectedValueOnce(
      new ForbiddenError('Profile is not linked to an account')
    );
    await expect(onboardingRedirect()).resolves.toBeNull();
  });

  it('fails open on a database error — the server still refuses the writes', async () => {
    h.loadOnboardingState.mockRejectedValue(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(onboardingRedirect()).resolves.toBeNull();
    err.mockRestore();
  });
});

describe('onboardingRedirect — /billing stays open for anyone who is not incomplete', () => {
  it('a paying owner still owing the company step reaches /billing and /billing/return', async () => {
    h.loadOnboardingState.mockResolvedValue({
      step: 'company',
      status: 'active',
    });
    for (const path of ['/billing', '/billing/return']) {
      h.path = path;
      await expect(onboardingRedirect()).resolves.toBeNull();
    }
    // …but is asked for it anywhere else in the CRM.
    h.path = '/dashboard';
    await expect(onboardingRedirect()).resolves.toBe('/onboarding');
  });

  it('an incomplete account is sent to /onboarding even from /billing', async () => {
    h.loadOnboardingState.mockResolvedValue({
      step: 'plan',
      status: 'incomplete',
    });
    h.path = '/billing';
    await expect(onboardingRedirect()).resolves.toBe('/onboarding');
  });

  it('does not mistake a lookalike path for /billing, nor a missing header', async () => {
    h.loadOnboardingState.mockResolvedValue({
      step: 'company',
      status: 'active',
    });
    for (const path of ['/billingx', '/settings/billing', null]) {
      h.path = path;
      await expect(onboardingRedirect()).resolves.toBe('/onboarding');
    }
  });
});

describe('onboardingRedirect — accounts locked after paying, real state (review s9.6, finding 1)', () => {
  // The real `loadOnboardingState`, over a pre-073 account: no company
  // profile at all. The owner must not be trapped in /onboarding.
  beforeEach(async () => {
    const real = await vi.importActual<typeof import('./state')>('./state');
    h.loadOnboardingState.mockImplementation(real.loadOnboardingState);
  });

  function entitlements(status: string, extra: Record<string, unknown> = {}) {
    return {
      planId: 'pro',
      status,
      limits: {},
      features: [],
      readOnly: true,
      readOnlyReason: 'subscription',
      manualHold: false,
      trialEndsAt: null,
      ...extra,
    };
  }

  it.each([
    ['suspended', entitlements('suspended')],
    ['expired', entitlements('expired')],
    ['past_due past its grace', entitlements('past_due')],
    [
      'a manual hold',
      entitlements('active', {
        manualHold: true,
        readOnlyReason: 'manual_hold',
      }),
    ],
  ])(
    '%s: the owner without a profile goes straight in, from anywhere',
    async (_l, e) => {
      h.getEntitlements.mockResolvedValue(e);
      for (const path of ['/dashboard', '/billing', '/settings']) {
        h.path = path;
        await expect(onboardingRedirect()).resolves.toBeNull();
      }
    }
  );

  it('control: an active, writable owner without a profile is asked for it', async () => {
    h.getEntitlements.mockResolvedValue(
      entitlements('active', { readOnly: false, readOnlyReason: null })
    );
    await expect(onboardingRedirect()).resolves.toBe('/onboarding');
  });
});
