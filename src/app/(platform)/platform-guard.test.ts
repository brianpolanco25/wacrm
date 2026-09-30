import { describe, expect, it, vi } from 'vitest';

/**
 * s9.1: every route of the operator's panel is a 404 for anyone without
 * a `platform_admins` row — the layout AND each page, because Next's
 * layouts do not re-run on client navigation (see `guardPlatformPage`).
 */

const NOT_FOUND = 'NEXT_HTTP_ERROR_FALLBACK;404';

const requirePlatformAdmin = vi.fn();
vi.mock('@/lib/auth/platform', () => ({
  requirePlatformAdmin: () => requirePlatformAdmin(),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
  usePathname: () => '/platform',
}));
vi.mock('@/lib/auth/support-view', () => ({
  supportBanner: vi.fn(async () => null),
}));

const { ForbiddenError, UnauthorizedError } =
  await import('@/lib/auth/account');
const { guardPlatformPage } = await import('@/lib/auth/platform-page');
const Overview = (await import('./platform/page')).default;
const Accounts = (await import('./platform/accounts/page')).default;
const Plans = (await import('./platform/plans/page')).default;
const Operators = (await import('./platform/operators/page')).default;
const AccountFile = (await import('./platform/[id]/page')).default;
const Layout = (await import('./layout')).default;

const ADMIN = {
  supabase: {},
  userId: 'op-1',
  admin: { userId: 'op-1', grantedAt: null, note: null },
};

const ROUTES: Array<[string, () => Promise<unknown>]> = [
  ['/platform', () => Overview()],
  ['/platform/accounts', () => Accounts()],
  ['/platform/plans', () => Plans()],
  ['/platform/operators', () => Operators()],
  [
    '/platform/[id]',
    () => AccountFile({ params: Promise.resolve({ id: 'acc-1' }) }),
  ],
  ['(platform) layout', () => Layout({ children: null })],
];

// No `mockReset()` in a beforeEach: every test sets its own implementation
// (and `clearMocks` in vitest.config clears the calls between tests).

describe('guardPlatformPage', () => {
  it('hands back the operator context', async () => {
    requirePlatformAdmin.mockResolvedValue(ADMIN);
    await expect(guardPlatformPage()).resolves.toBe(ADMIN);
  });

  it.each([
    ['a tenant (403)', () => new ForbiddenError('no')],
    ['no session (401)', () => new UnauthorizedError()],
    ['anything else', () => new Error('db down')],
  ])('404s for %s', async (_label, err) => {
    requirePlatformAdmin.mockRejectedValue(err());
    await expect(guardPlatformPage()).rejects.toThrow(NOT_FOUND);
  });
});

describe.each(ROUTES)('%s', (_route, render) => {
  it('is a 404 for a user without platform_admins', async () => {
    requirePlatformAdmin.mockRejectedValue(new ForbiddenError('no'));
    await expect(render()).rejects.toThrow(NOT_FOUND);
    expect(requirePlatformAdmin).toHaveBeenCalled();
  });

  it('renders for a platform admin', async () => {
    requirePlatformAdmin.mockResolvedValue(ADMIN);
    await expect(render()).resolves.toBeTruthy();
  });
});
