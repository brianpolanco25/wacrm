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

  it('an invite still wins, for operators too, without asking', async () => {
    const fetchImpl = answer(200);
    await expect(postLoginDestination('a b/c', fetchImpl)).resolves.toBe(
      '/join/a%20b%2Fc'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
