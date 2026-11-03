import { describe, expect, it } from 'vitest';

import { authCallbackUrl } from './redirects';
import {
  isInviteSignupRejection,
  signupInviteGate,
  signupOptions,
} from './signup-invite';

// i12.1 — /signup?invite= (R8, R9, R10, R32).

const PEEK_OK = {
  ok: true,
  account_name: 'Acme',
  role: 'viewer',
  expires_at: '2026-11-10T00:00:00.000Z',
};

describe('signupInviteGate (R8)', () => {
  it('no token → the plain form', () => {
    expect(signupInviteGate(null, undefined)).toEqual({ kind: 'none' });
    expect(signupInviteGate('', PEEK_OK)).toEqual({ kind: 'none' });
  });

  it('token without an answer yet → loading', () => {
    expect(signupInviteGate('t', undefined)).toEqual({ kind: 'loading' });
  });

  it('a good invitation → the form, with company and role', () => {
    expect(signupInviteGate('t', PEEK_OK)).toEqual({
      kind: 'ok',
      peek: {
        account_name: 'Acme',
        role: 'viewer',
        expires_at: PEEK_OK.expires_at,
      },
    });
  });

  it.each(['not_found', 'used', 'expired', 'no_seats', 'server_error'])(
    'a %s invitation → the failure, no form',
    (reason) => {
      expect(signupInviteGate('t', { ok: false, reason })).toEqual({
        kind: 'fail',
        reason,
      });
    }
  );

  it('an unreadable answer → server_error', () => {
    expect(signupInviteGate('t', null)).toEqual({
      kind: 'fail',
      reason: 'server_error',
    });
  });
});

describe('signupOptions (R9)', () => {
  it('with a token: invite_token in data, and the callback keeps ?invite=', () => {
    const out = signupOptions({
      fullName: 'Ana',
      inviteToken: 'tok-1',
      origin: 'https://crm.example.com',
    });
    expect(out).toEqual({
      data: { full_name: 'Ana', invite_token: 'tok-1' },
      emailRedirectTo: authCallbackUrl('https://crm.example.com', {
        invite: 'tok-1',
      }),
    });
    expect(new URL(out.emailRedirectTo).searchParams.get('invite')).toBe(
      'tok-1'
    );
  });

  it('without a token: no invite_token key at all', () => {
    const out = signupOptions({
      fullName: 'Ana',
      inviteToken: null,
      origin: 'https://crm.example.com',
    });
    expect(out.data).toEqual({ full_name: 'Ana' });
    expect('invite_token' in out.data).toBe(false);
    expect(out.emailRedirectTo).toBe('https://crm.example.com/auth/callback');
  });
});

describe('isInviteSignupRejection (R10)', () => {
  it('a 500 is the trigger refusing', () => {
    expect(isInviteSignupRejection({ status: 500, message: 'x' })).toBe(true);
  });

  it('GoTrue’s text is the trigger refusing, whatever the status', () => {
    expect(
      isInviteSignupRejection({ message: 'Database error saving new user' })
    ).toBe(true);
  });

  it('a weak password (400) is a form problem, not the invitation', () => {
    expect(
      isInviteSignupRejection({
        status: 400,
        message: 'Password should be at least 6 characters',
      })
    ).toBe(false);
    expect(isInviteSignupRejection({ status: 429, message: 'rate' })).toBe(
      false
    );
    expect(isInviteSignupRejection(null)).toBe(false);
  });
});
