import { describe, expect, it, vi } from 'vitest';

import { postLoginDestination } from './post-login';

/** s9.1: where the login form sends the browser once signed in. */

function answer(status: number) {
  return vi.fn(
    async () => new Response('{}', { status })
  ) as unknown as typeof fetch;
}

describe('postLoginDestination', () => {
  it('sends a platform admin to /platform', async () => {
    const fetchImpl = answer(200);
    await expect(postLoginDestination(null, fetchImpl)).resolves.toBe(
      '/platform'
    );
    expect(fetchImpl).toHaveBeenCalledWith('/api/platform/me', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
  });

  it('sends everyone else (403 from /api/platform/me) to /dashboard', async () => {
    await expect(postLoginDestination(null, answer(403))).resolves.toBe(
      '/dashboard'
    );
  });

  it('fails toward /dashboard when the check itself fails', async () => {
    await expect(postLoginDestination(null, answer(500))).resolves.toBe(
      '/dashboard'
    );
    const offline = vi.fn(async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await expect(postLoginDestination(null, offline)).resolves.toBe(
      '/dashboard'
    );
  });

  it('gives up on a /api/platform/me that never answers → /dashboard', async () => {
    // Ignores the abort signal on purpose: the bound must not depend on
    // `fetch` honouring it.
    const hung = vi.fn(
      () => new Promise<Response>(() => {})
    ) as unknown as typeof fetch;
    await expect(postLoginDestination(null, hung, 20)).resolves.toBe(
      '/dashboard'
    );
  });

  it('treats an aborted request (TimeoutError) as "not an operator"', async () => {
    const aborted = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as unknown as typeof fetch;
    await expect(postLoginDestination(null, aborted)).resolves.toBe(
      '/dashboard'
    );
  });

  it('waits at most a few seconds by default', async () => {
    const { PLATFORM_CHECK_TIMEOUT_MS } = await import('./post-login');
    expect(PLATFORM_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(2000);
    expect(PLATFORM_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });

  it('an invite still wins, for operators too, without asking', async () => {
    const fetchImpl = answer(200);
    await expect(postLoginDestination('a b/c', fetchImpl)).resolves.toBe(
      '/join/a%20b%2Fc'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
