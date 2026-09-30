import { describe, expect, it } from 'vitest';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

import nextConfig from '../next.config';

// s9.4: the operator's console must never sit in a shared cache. The
// catch-all of `next.config.ts` puts `public, s-maxage=300` on every
// page outside /api; the /platform rule has to beat it, on every URL of
// the console, and nothing else may change.
//
// Evaluated the way Next evaluates it: every rule whose `source`
// matches contributes its headers, in order, and for the same key the
// LAST one wins (next/dist/docs/01-app/03-api-reference/05-config/
// 01-next-config-js/headers.md). The matcher is Next's own.

type HeaderRule = {
  source: string;
  headers: { key: string; value: string }[];
};

async function effectiveHeaders(pathname: string) {
  const rules = (await nextConfig.headers!()) as HeaderRule[];
  const out = new Map<string, string>();
  for (const rule of rules) {
    if (getPathMatch(rule.source)(pathname) === false) continue;
    for (const { key, value } of rule.headers) {
      out.set(key.toLowerCase(), value);
    }
  }
  return out;
}

describe('Cache-Control of the platform console (s9.4)', () => {
  it.each([
    '/platform',
    '/platform/',
    '/platform/accounts',
    '/platform/plans',
    '/platform/operators',
    '/platform/aaaaaaaa-0000-4000-8000-000000000001',
  ])('%s is private, no-store — never public', async (path) => {
    const headers = await effectiveHeaders(path);
    expect(headers.get('cache-control')).toBe('private, no-store');
  });

  it('keeps the security headers on the console', async () => {
    const headers = await effectiveHeaders('/platform/accounts');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('strict-transport-security')).toBeTruthy();
  });

  it('leaves the rest of the app as it was', async () => {
    expect((await effectiveHeaders('/dashboard')).get('cache-control')).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400'
    );
    expect(
      (await effectiveHeaders('/api/platform/accounts')).get('cache-control')
    ).toBe('no-store');
    expect(
      (await effectiveHeaders('/api/v1/openapi.json')).get('cache-control')
    ).toBe('public, max-age=3600, stale-while-revalidate=604800');
  });

  it('does not catch a page that merely starts with the word', async () => {
    // `/platformer` is not the console.
    expect((await effectiveHeaders('/platformer')).get('cache-control')).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400'
    );
  });
});
