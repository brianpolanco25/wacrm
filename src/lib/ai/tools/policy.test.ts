import { describe, expect, it } from 'vitest';

// n13.7 R23, R29: política de IA de una operación.

import {
  checkRequiresPrior,
  groundsSchedule,
  policyProblem,
  sanitizePolicy,
} from './policy';
import type { PriorEvidence } from './types';

const CANCEL = {
  requires_prior: [
    ['list_appointments', 'get_appointment'],
    ['find_availability'],
  ],
};
const ev = (...keys: string[]): PriorEvidence[] =>
  keys.map((k) => ({ integrationSlug: 'cabbity-health', operationKey: k }));

describe('checkRequiresPrior (R29)', () => {
  it('list_appointments then find_availability → ok', () => {
    expect(
      checkRequiresPrior(
        CANCEL,
        'cabbity-health',
        ev('list_appointments', 'find_availability')
      )
    ).toEqual({ ok: true });
  });

  it('get_appointment is an alternative of the first step', () => {
    expect(
      checkRequiresPrior(
        CANCEL,
        'cabbity-health',
        ev('get_appointment', 'find_availability')
      )
    ).toEqual({ ok: true });
  });

  it('reverse order → step 2 missing', () => {
    expect(
      checkRequiresPrior(
        CANCEL,
        'cabbity-health',
        ev('find_availability', 'list_appointments')
      )
    ).toEqual({ ok: false, missing: [['find_availability']] });
  });

  it('evidence of another integration does not count', () => {
    expect(
      checkRequiresPrior(CANCEL, 'cabbity-health', [
        { integrationSlug: 'other', operationKey: 'list_appointments' },
        { integrationSlug: 'other', operationKey: 'find_availability' },
      ])
    ).toEqual({ ok: false, missing: CANCEL.requires_prior });
  });

  it('no evidence → both steps missing', () => {
    expect(checkRequiresPrior(CANCEL, 'cabbity-health', [])).toEqual({
      ok: false,
      missing: CANCEL.requires_prior,
    });
  });

  it('no policy → ok', () => {
    expect(checkRequiresPrior(null, 'x', [])).toEqual({ ok: true });
    expect(checkRequiresPrior({ grounds: ['schedule'] }, 'x', [])).toEqual({
      ok: true,
    });
  });
});

describe('policyProblem / sanitizePolicy (R23, R26)', () => {
  it.each([undefined, null, {}, { grounds: ['schedule'] }, CANCEL])(
    'accepts %j',
    (p) => expect(policyProblem(p)).toBeNull()
  );

  it.each([
    ['a string', 'schedule'],
    ['an array', []],
    ['an unknown key', { grounds: ['schedule'], other: 1 }],
    ['grounds outside the list', { grounds: ['price'] }],
    ['grounds not a list', { grounds: 'schedule' }],
    ['4 steps', { requires_prior: [['aa'], ['bb'], ['cc'], ['dd']] }],
    ['an empty step', { requires_prior: [[]] }],
    ['5 keys in a step', { requires_prior: [['aa', 'bb', 'cc', 'dd', 'ee']] }],
    ['a bad key', { requires_prior: [['Bad-Key']] }],
    ['a non-string key', { requires_prior: [[3]] }],
  ])('rejects %s', (_label, p) => expect(policyProblem(p)).not.toBeNull());

  it('sanitizePolicy: invalid → null, empty → null, valid → a copy', () => {
    expect(sanitizePolicy({ grounds: ['price'] })).toBeNull();
    expect(sanitizePolicy({})).toBeNull();
    expect(sanitizePolicy(CANCEL)).toEqual(CANCEL);
    expect(groundsSchedule(sanitizePolicy({ grounds: ['schedule'] }))).toBe(
      true
    );
    expect(groundsSchedule(null)).toBe(false);
  });
});
