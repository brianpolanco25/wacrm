import { describe, expect, it } from 'vitest';

import {
  authCallbackUrl,
  callbackDestination,
  resetPasswordPath,
  safeNextPath,
} from './redirects';

describe('authCallbackUrl — the redirectTo of every auth email (s9.8)', () => {
  it('sign-up without invite: the bare callback', () => {
    expect(authCallbackUrl('https://app.test')).toBe(
      'https://app.test/auth/callback'
    );
  });

  it('recovery / owner invite: next=/reset-password', () => {
    expect(
      authCallbackUrl('https://app.test/', { next: '/reset-password' })
    ).toBe('https://app.test/auth/callback?next=%2Freset-password');
  });

  it('member invite: carries the invite token too', () => {
    const url = new URL(
      authCallbackUrl('https://app.test', {
        next: '/reset-password',
        invite: 'tok/1',
      })
    );
    expect(url.pathname).toBe('/auth/callback');
    expect(url.searchParams.get('next')).toBe('/reset-password');
    expect(url.searchParams.get('invite')).toBe('tok/1');
  });

  it('drops a next that leaves the site', () => {
    expect(authCallbackUrl('https://app.test', { next: '//evil.test' })).toBe(
      'https://app.test/auth/callback'
    );
  });
});

describe('safeNextPath', () => {
  it.each(['/dashboard', '/reset-password?invite=a', '/join/abc'])(
    'keeps same-origin path %s',
    (p) => {
      expect(safeNextPath(p)).toBe(p);
    }
  );

  it.each([
    null,
    '',
    'dashboard',
    'https://evil.test/x',
    '//evil.test',
    '/\\evil.test',
    '/\tx',
    'javascript:alert(1)',
  ])('refuses %s', (p) => {
    expect(safeNextPath(p)).toBeNull();
  });
});

describe('callbackDestination', () => {
  it('invite → /reset-password with the welcome wording', () => {
    expect(callbackDestination({ type: 'invite' })).toBe(
      '/reset-password?welcome=1'
    );
  });

  it('recovery → /reset-password even if next says otherwise', () => {
    expect(callbackDestination({ type: 'recovery', next: '/dashboard' })).toBe(
      '/reset-password'
    );
  });

  it('invite keeps ?invite= for the join step afterwards', () => {
    expect(callbackDestination({ type: 'invite', invite: 'tok' })).toBe(
      '/reset-password?invite=tok&welcome=1'
    );
  });

  it('next=/reset-password also gets the invite', () => {
    expect(
      callbackDestination({ next: '/reset-password', invite: 'tok' })
    ).toBe('/reset-password?invite=tok');
  });

  it('signup with invite → /join/<token>', () => {
    expect(callbackDestination({ type: 'signup', invite: 'a b' })).toBe(
      '/join/a%20b'
    );
  });

  it('signup / email without anything → null (caller default)', () => {
    expect(callbackDestination({ type: 'signup' })).toBeNull();
    expect(callbackDestination({ type: 'email' })).toBeNull();
    expect(callbackDestination({})).toBeNull();
  });

  it('a safe next wins over the default; an unsafe one is ignored', () => {
    expect(callbackDestination({ type: 'email', next: '/settings' })).toBe(
      '/settings'
    );
    expect(
      callbackDestination({ type: 'email', next: 'https://evil.test' })
    ).toBeNull();
  });
});

describe('resetPasswordPath', () => {
  it('plain, with invite, with welcome', () => {
    expect(resetPasswordPath({})).toBe('/reset-password');
    expect(resetPasswordPath({ invite: 'x', welcome: true })).toBe(
      '/reset-password?invite=x&welcome=1'
    );
  });
});
