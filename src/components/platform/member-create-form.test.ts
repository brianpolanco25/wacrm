import { describe, expect, it } from 'vitest';

import {
  MEMBER_CREATE_ROLES,
  memberCreateErrorKey,
  validateMemberCreate,
} from './member-create-form';

// «Crear miembro» (i12.2): what the form refuses before any request (R27)
// and which text each answer of the route shows (R29).

const VALID = {
  fullName: 'Ana Agent',
  email: 'ana@acme.test',
  role: 'agent',
  password: 'Clave-Secreta-2026',
  reason: 'el alta por enlace no llegó',
};

describe('validateMemberCreate (R27)', () => {
  it('accepts a valid form, at the bounds too', () => {
    expect(validateMemberCreate(VALID)).toBeNull();
    expect(
      validateMemberCreate({
        ...VALID,
        fullName: 'a'.repeat(120),
        password: 'a'.repeat(8),
        reason: 'a'.repeat(10),
      })
    ).toBeNull();
    expect(
      validateMemberCreate({ ...VALID, password: 'a'.repeat(72) })
    ).toBeNull();
  });

  it.each([
    [
      'an empty name',
      { fullName: '   ' },
      'memberCreateNameInvalid',
      { max: 120 },
    ],
    [
      'a 121-char name',
      { fullName: 'a'.repeat(121) },
      'memberCreateNameInvalid',
      { max: 120 },
    ],
    ['no @', { email: 'ana.acme.test' }, 'memberCreateEmailInvalid', undefined],
    [
      'no dot in the domain',
      { email: 'ana@acme' },
      'memberCreateEmailInvalid',
      undefined,
    ],
    ['the owner role', { role: 'owner' }, 'memberCreateInvalid', undefined],
    ['no role', { role: '' }, 'memberCreateInvalid', undefined],
    [
      'a 7-char password',
      { password: 'a'.repeat(7) },
      'memberCreatePasswordInvalid',
      { min: 8, max: 72 },
    ],
    [
      'a 73-char password',
      { password: 'a'.repeat(73) },
      'memberCreatePasswordInvalid',
      { min: 8, max: 72 },
    ],
    [
      'a short reason',
      { reason: '  corto   ' },
      'memberCreateReasonShort',
      { min: 10 },
    ],
  ])('refuses %s', (_label, patch, key, values) => {
    const out = validateMemberCreate({ ...VALID, ...patch });
    expect(out?.key).toBe(key);
    expect(out?.values).toEqual(values);
  });

  it('offers admin, agent and viewer — never owner', () => {
    expect([...MEMBER_CREATE_ROLES]).toEqual(['admin', 'agent', 'viewer']);
  });
});

describe('memberCreateErrorKey (R29)', () => {
  it.each([
    [409, 'already_member', 'memberCreateAlreadyMember'],
    [409, 'email_exists', 'memberCreateEmailExists'],
    [409, 'is_operator', 'memberCreateIsOperator'],
    [409, 'rejected', 'memberCreateRejected'],
    [409, 'whatever', 'memberCreateFailed'],
    [402, 'plan_limit_reached', 'memberCreateNoSeats'],
    [402, undefined, 'memberCreateNoSeats'],
    [400, 'invalid_password', 'memberCreatePasswordInvalid'],
    [400, 'invalid_email', 'memberCreateInvalid'],
    [400, 'invalid_name', 'memberCreateInvalid'],
    [400, undefined, 'memberCreateInvalid'],
    [500, undefined, 'memberCreateFailed'],
    [502, 'create_failed', 'memberCreateFailed'],
    [429, undefined, 'memberCreateFailed'],
    [403, undefined, 'memberCreateFailed'],
  ])('%i %s → %s', (status, code, key) => {
    expect(memberCreateErrorKey(status, code)).toBe(key);
  });
});
