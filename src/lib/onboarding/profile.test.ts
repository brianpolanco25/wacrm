import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  COUNTRIES,
  INDUSTRIES,
  TEAM_SIZES,
  isProfileComplete,
  normalizePhone,
  validateCompanyProfile,
} from './profile';

// s9.6, decision 6: the company profile of the paid onboarding.

const VALID = {
  name: '  Ferretería Polanco  ',
  country: 'do',
  phone: '+1 (809) 555-0101',
  industry: 'retail',
  teamSize: '2-5',
};

describe('validateCompanyProfile', () => {
  it('accepts a complete profile and normalises it', () => {
    const r = validateCompanyProfile(VALID);
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Ferretería Polanco',
        country: 'DO',
        phone: '+1 (809) 555-0101',
        industry: 'retail',
        teamSize: '2-5',
      },
    });
  });

  it.each([
    ['name', { name: '   ' }],
    ['name', { name: 'x'.repeat(81) }],
    ['name', { name: 42 }],
    ['country', { country: 'DOM' }],
    ['country', { country: 'ZZ' }],
    ['country', { country: undefined }],
    ['phone', { phone: '12345' }],
    ['phone', { phone: '1234567890123456' }],
    ['phone', { phone: 'call me' }],
    ['phone', { phone: '+1 809 555 0101 ext 4' }],
    ['industry', { industry: 'mining' }],
    ['teamSize', { teamSize: '7' }],
    ['teamSize', { teamSize: 5 }],
  ])('refuses a bad %s (%j)', (field, patch) => {
    const r = validateCompanyProfile({ ...VALID, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe(field);
      expect(r.error).toMatch(new RegExp(`'${field}'`));
    }
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, undefined, 'x', 3, []]) {
      expect(validateCompanyProfile(body).ok).toBe(false);
    }
  });

  it('ignores fields it does not know — an accountId in the body is not a field', () => {
    const r = validateCompanyProfile({
      ...VALID,
      accountId: 'acct-b',
      id: 'x',
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(Object.keys(r.value).sort()).toEqual([
        'country',
        'industry',
        'name',
        'phone',
        'teamSize',
      ]);
  });
});

describe('normalizePhone', () => {
  it('collapses whitespace and keeps the punctuation people type', () => {
    expect(normalizePhone('  +34   600 11 22 33 ')).toBe('+34 600 11 22 33');
    expect(normalizePhone('809.555.0101')).toBe('809.555.0101');
  });
});

describe('isProfileComplete', () => {
  it('needs the four columns the 073 CHECK needs', () => {
    const full = {
      country: 'DO',
      phone: '8095550101',
      industry: 'retail',
      team_size: '1',
    };
    expect(isProfileComplete(full)).toBe(true);
    for (const key of Object.keys(full)) {
      expect(isProfileComplete({ ...full, [key]: null })).toBe(false);
    }
    expect(isProfileComplete(null)).toBe(false);
  });
});

describe('lists match migration 073', () => {
  const sql = readFileSync(
    path.join(process.cwd(), 'supabase/migrations/073_no_trial.sql'),
    'utf8'
  );

  it('team sizes are exactly the CHECK list', () => {
    const check = /team_size IN \(([^)]*)\)/.exec(sql)?.[1] ?? '';
    const fromSql = [...check.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(fromSql).toEqual([...TEAM_SIZES]);
  });

  it('every country satisfies the alpha-2 CHECK, and every industry fits its length CHECK', () => {
    for (const c of COUNTRIES) expect(c).toMatch(/^[A-Z]{2}$/);
    expect(new Set(COUNTRIES).size).toBe(COUNTRIES.length);
    for (const i of INDUSTRIES) expect(i.length).toBeLessThanOrEqual(40);
    expect(INDUSTRIES).toContain('other');
  });
});
