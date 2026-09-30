import { describe, expect, it, vi } from 'vitest';

import {
  MIN_PASSWORD_LENGTH,
  submitNewPassword,
  validateNewPassword,
} from './reset-password';

/**
 * s9.8 — /reset-password: the checks before anything is sent, the
 * `updateUser` call, and where each kind of person lands afterwards
 * (s9.1's `postLoginDestination`: invite → /join, operator → /platform,
 * anyone else → /dashboard).
 */

type Auth = Parameters<typeof submitNewPassword>[0]['auth'];

function auth(error: { name?: string; code?: string } | null = null) {
  const updateUser = vi.fn(async () => ({ data: { user: null }, error }));
  return { auth: { updateUser } as unknown as Auth, updateUser };
}

const ok = () => new Response('{}', { status: 200 });
const forbidden = () => new Response('{}', { status: 404 });

describe('validateNewPassword', () => {
  it('mismatch first, then length', () => {
    expect(validateNewPassword('abcdef', 'abcdeg')).toBe('mismatch');
    expect(validateNewPassword('abc', 'abc')).toBe('tooShort');
    expect(
      validateNewPassword(
        'a'.repeat(MIN_PASSWORD_LENGTH),
        'a'.repeat(MIN_PASSWORD_LENGTH)
      )
    ).toBeNull();
  });

  it('uses the same floor as /signup', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(6);
  });
});

describe('submitNewPassword', () => {
  it('different passwords: nothing is sent', async () => {
    const a = auth();
    expect(
      await submitNewPassword({
        password: 'secret1',
        confirm: 'secret2',
        invite: null,
        auth: a.auth,
      })
    ).toEqual({ ok: false, error: 'mismatch' });
    expect(a.updateUser).not.toHaveBeenCalled();
  });

  it('too short: nothing is sent', async () => {
    const a = auth();
    expect(
      await submitNewPassword({
        password: 'abc',
        confirm: 'abc',
        invite: null,
        auth: a.auth,
      })
    ).toEqual({ ok: false, error: 'tooShort' });
    expect(a.updateUser).not.toHaveBeenCalled();
  });

  it('no session → noSession (the page then offers a new link)', async () => {
    const a = auth({ name: 'AuthSessionMissingError' });
    expect(
      await submitNewPassword({
        password: 'secret1',
        confirm: 'secret1',
        invite: null,
        auth: a.auth,
      })
    ).toEqual({ ok: false, error: 'noSession' });
  });

  it.each([
    ['same_password', 'samePassword'],
    ['weak_password', 'weakPassword'],
    ['session_not_found', 'noSession'],
    ['unexpected_failure', 'failed'],
  ])('GoTrue %s → %s', async (code, expected) => {
    const a = auth({ code });
    expect(
      await submitNewPassword({
        password: 'secret1',
        confirm: 'secret1',
        invite: null,
        auth: a.auth,
      })
    ).toEqual({ ok: false, error: expected });
  });

  it('success with an invite → /join/<token>, without asking about operators', async () => {
    const a = auth();
    const fetchImpl = vi.fn(async () => ok());
    expect(
      await submitNewPassword({
        password: 'secret1',
        confirm: 'secret1',
        invite: 'tok',
        auth: a.auth,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).toEqual({ ok: true, destination: '/join/tok' });
    expect(a.updateUser).toHaveBeenCalledWith({ password: 'secret1' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('success as an operator → /platform', async () => {
    const a = auth();
    const fetchImpl = vi.fn(async () => ok());
    expect(
      await submitNewPassword({
        password: 'secret1',
        confirm: 'secret1',
        invite: null,
        auth: a.auth,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).toEqual({ ok: true, destination: '/platform' });
  });

  it('success as anyone else → /dashboard', async () => {
    const a = auth();
    const fetchImpl = vi.fn(async () => forbidden());
    expect(
      await submitNewPassword({
        password: 'secret1',
        confirm: 'secret1',
        invite: null,
        auth: a.auth,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).toEqual({ ok: true, destination: '/dashboard' });
  });
});
