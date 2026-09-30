import { describe, expect, it } from 'vitest';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

import nextConfig from '../next.config';

// s9.8: the redirect of /auth/callback carries session cookies, and the
// catch-all of `next.config.ts` (`public, s-maxage=300`) beats whatever
// the route handler sets. Evaluated the way Next does: every matching
// rule contributes, the last one wins per key; the matcher is Next's.

type HeaderRule = {
  source: string;
  headers: { key: string; value: string }[];
};

async function cacheControl(pathname: string) {
  const rules = (await nextConfig.headers!()) as HeaderRule[];
  let value: string | undefined;
  for (const rule of rules) {
    if (getPathMatch(rule.source)(pathname) === false) continue;
    for (const h of rule.headers) {
      if (h.key.toLowerCase() === 'cache-control') value = h.value;
    }
  }
  return value;
}

describe('Cache-Control of /auth/* (s9.8)', () => {
  it.each(['/auth/callback', '/auth/callback/complete'])(
    '%s is private, no-store',
    async (path) => {
      expect(await cacheControl(path)).toBe('private, no-store');
    }
  );

  it('leaves the rest of the app as it was', async () => {
    expect(await cacheControl('/login')).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400'
    );
    expect(await cacheControl('/authors')).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400'
    );
  });
});
