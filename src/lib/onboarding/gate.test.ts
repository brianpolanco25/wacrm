import { beforeEach, describe, expect, it, vi } from 'vitest';

// s9.6: the onboarding gate the dashboard layout applies. Who is sent to
// /onboarding, who to /platform, and who goes straight in.

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadOnboardingState: vi.fn(),
  isPlatformAdmin: vi.fn(),
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
