import { describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * s9.6: the onboarding gate, where it runs and what it leaves alone.
 *
 *   - the (dashboard) layout redirects with whatever `onboardingRedirect`
 *     answers, and renders the CRM otherwise;
 *   - /onboarding and /onboarding/return send the signed-out to /login and
 *     the finished (or a support session) to /dashboard;
 *   - the exemptions hold by construction: nothing exempt lives under
 *     (dashboard), and no API route, webhook or cron consults the gate.
 */

const REDIRECT = 'NEXT_REDIRECT';

const h = vi.hoisted(() => ({
  onboardingRedirect: vi.fn(),
  getCurrentAccount: vi.fn(),
  loadOnboardingState: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`${REDIRECT}:${to}`);
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith(REDIRECT)) throw err;
  },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}));
vi.mock('@/lib/onboarding/gate', () => ({
  onboardingRedirect: h.onboardingRedirect,
}));
vi.mock('@/lib/auth/support-view', () => ({
  supportBanner: vi.fn(async () => null),
}));
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: h.getCurrentAccount,
}));
vi.mock('@/lib/onboarding/state', () => ({
  loadOnboardingState: h.loadOnboardingState,
}));

const { UnauthorizedError } = await import('@/lib/auth/account');
const DashboardLayout = (await import('../(dashboard)/layout')).default;
const { requireOnboardingPage } = await import('@/lib/onboarding/page-state');

const CTX = {
  userId: 'u1',
  accountId: 'a1',
  role: 'owner',
  account: { id: 'a1', name: 'Acme' },
  impersonation: null,
};

describe('(dashboard) layout', () => {
  it('redirects an incomplete account to /onboarding', async () => {
    h.onboardingRedirect.mockResolvedValue('/onboarding');
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      `${REDIRECT}:/onboarding`
    );
  });

  it('redirects an operator with an unpaid company to /platform', async () => {
    h.onboardingRedirect.mockResolvedValue('/platform');
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      `${REDIRECT}:/platform`
    );
  });

  it('renders the CRM when the gate is open (active, manual, members, support)', async () => {
    h.onboardingRedirect.mockResolvedValue(null);
    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
  });
});

describe('the onboarding pages', () => {
  it('send the signed-out to /login', async () => {
    h.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    await expect(requireOnboardingPage()).rejects.toThrow(`${REDIRECT}:/login`);
  });

  it('send a finished onboarding to /dashboard', async () => {
    h.getCurrentAccount.mockResolvedValue(CTX);
    h.loadOnboardingState.mockResolvedValue({ step: 'done' });
    await expect(requireOnboardingPage()).rejects.toThrow(
      `${REDIRECT}:/dashboard`
    );
  });

  it('send a support session to /dashboard without resolving a step', async () => {
    h.getCurrentAccount.mockResolvedValue({
      ...CTX,
      impersonation: { accountId: 'a1' },
    });
    await expect(requireOnboardingPage()).rejects.toThrow(
      `${REDIRECT}:/dashboard`
    );
    expect(h.loadOnboardingState).not.toHaveBeenCalled();
  });

  it('render for an account that is still signing up', async () => {
    h.getCurrentAccount.mockResolvedValue(CTX);
    h.loadOnboardingState.mockResolvedValue({ step: 'plan' });
    await expect(requireOnboardingPage()).resolves.toMatchObject({
      state: { step: 'plan' },
    });
  });
});

// ------------------------------------------------------------
// Exemptions, by construction.
// ------------------------------------------------------------
const APP = path.join(process.cwd(), 'src/app');

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe('what the gate never sees', () => {
  it('keeps the onboarding pages out of (dashboard), so the gate cannot loop', () => {
    expect(existsSync(path.join(APP, '(onboarding)/onboarding/page.tsx'))).toBe(
      true
    );
    expect(
      existsSync(path.join(APP, '(onboarding)/onboarding/return/page.tsx'))
    ).toBe(true);
    expect(existsSync(path.join(APP, '(dashboard)/onboarding'))).toBe(false);
  });

  it.each(['platform', 'join', 'auth', 'reset-password', 'login', 'signup'])(
    '/%s does not render under the (dashboard) layout',
    (segment) => {
      expect(existsSync(path.join(APP, '(dashboard)', segment))).toBe(false);
    }
  );

  it('is consulted by the dashboard layout only — no API route, webhook or cron', () => {
    const users = filesUnder(APP)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes('@/lib/onboarding/gate'))
      .map((f) => path.relative(APP, f));
    expect(users).toEqual(['(dashboard)/layout.tsx']);
  });

  it('the middleware never resolves the gate: it only forwards the path (no state, no database)', () => {
    const mw = readFileSync(
      path.join(process.cwd(), 'src/middleware.ts'),
      'utf8'
    );
    const onboardingImports = [
      ...mw.matchAll(/from '(@\/lib\/onboarding\/[^']+)'/g),
    ].map((m) => m[1]);
    expect(onboardingImports).toEqual(['@/lib/onboarding/path-header']);
    // And that module imports nothing (Edge-safe).
    const header = readFileSync(
      path.join(process.cwd(), 'src/lib/onboarding/path-header.ts'),
      'utf8'
    );
    expect(header).not.toMatch(/^import /m);
  });
});
