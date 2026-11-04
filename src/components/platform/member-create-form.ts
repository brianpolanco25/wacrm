// ============================================================
// «Crear miembro» (i12.2) — the pure half of the form: validation before
// any request, and which text an error response shows. No I/O, no React,
// so it is tested as a table.
//
// The bounds are the route's (`password-rules.ts`, `MIN_REASON_LENGTH`),
// imported from client-safe modules; the route stays the authority and
// validates everything again.
// ============================================================

import { MIN_REASON_LENGTH } from '@/lib/auth/support-cookie';
import {
  MAX_MEMBER_NAME_LENGTH,
  OPERATOR_MAX_PASSWORD_LENGTH,
  OPERATOR_MIN_PASSWORD_LENGTH,
} from '@/lib/platform/password-rules';

/** The roles a created member may have. Never `owner`. */
export const MEMBER_CREATE_ROLES = ['admin', 'agent', 'viewer'] as const;
export type MemberCreateRole = (typeof MEMBER_CREATE_ROLES)[number];

export type MemberCreateInput = {
  fullName: string;
  email: string;
  role: string;
  password: string;
  reason: string;
};

export type MemberCreateError = {
  key: string;
  values?: Record<string, number>;
} | null;

// Loose on purpose, as on the server (`normalizeEmail`): one `@`,
// something on each side, a dot in the domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The first problem of the form, as a `Platform` i18n key, or null. */
export function validateMemberCreate(
  input: MemberCreateInput
): MemberCreateError {
  const name = input.fullName.trim();
  if (!name || name.length > MAX_MEMBER_NAME_LENGTH) {
    return {
      key: 'memberCreateNameInvalid',
      values: { max: MAX_MEMBER_NAME_LENGTH },
    };
  }
  if (!EMAIL_RE.test(input.email.trim())) {
    return { key: 'memberCreateEmailInvalid' };
  }
  if (!(MEMBER_CREATE_ROLES as readonly string[]).includes(input.role)) {
    return { key: 'memberCreateInvalid' };
  }
  if (
    input.password.length < OPERATOR_MIN_PASSWORD_LENGTH ||
    input.password.length > OPERATOR_MAX_PASSWORD_LENGTH
  ) {
    return {
      key: 'memberCreatePasswordInvalid',
      values: {
        min: OPERATOR_MIN_PASSWORD_LENGTH,
        max: OPERATOR_MAX_PASSWORD_LENGTH,
      },
    };
  }
  if (input.reason.trim().length < MIN_REASON_LENGTH) {
    return {
      key: 'memberCreateReasonShort',
      values: { min: MIN_REASON_LENGTH },
    };
  }
  return null;
}

/** The `Platform` i18n key for an error answer of the route. */
export function memberCreateErrorKey(
  status: number,
  code: string | undefined
): string {
  if (status === 409) {
    switch (code) {
      case 'already_member':
        return 'memberCreateAlreadyMember';
      case 'email_exists':
        return 'memberCreateEmailExists';
      case 'is_operator':
        return 'memberCreateIsOperator';
      case 'rejected':
        return 'memberCreateRejected';
    }
    return 'memberCreateFailed';
  }
  if (status === 402) return 'memberCreateNoSeats';
  if (status === 400) {
    return code === 'invalid_password'
      ? 'memberCreatePasswordInvalid'
      : 'memberCreateInvalid';
  }
  return 'memberCreateFailed';
}
