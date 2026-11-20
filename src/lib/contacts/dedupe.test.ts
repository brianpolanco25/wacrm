import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dedupeByPhone,
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  normalizeKey,
} from './dedupe';

describe('normalizeKey', () => {
  it('strips every non-digit', () => {
    expect(normalizeKey('+1 (555) 123-4567')).toBe('15551234567');
    expect(normalizeKey('15551234567')).toBe('15551234567');
  });

  it('collapses different formats of the same number to one key', () => {
    expect(normalizeKey('+44 7911 123456')).toBe(normalizeKey('447911123456'));
  });
});

describe('isExactMatch', () => {
  it('treats different formatting of the same digits as exact', () => {
    expect(
      isExactMatch({ id: '1', phone: '+1 555-123-4567' }, '15551234567')
    ).toBe(true);
  });

  it('is false for a trunk-variant (fuzzy) match', () => {
    // last-8 match but not the same full number
    expect(
      isExactMatch({ id: '1', phone: '37063949836' }, '370063949836')
    ).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('detects Postgres 23505', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });
  it('is false for other errors / non-objects', () => {
    expect(isUniqueViolation({ code: '23502' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
  });
});

describe('dedupeByPhone', () => {
  it('keeps the first occurrence and counts in-file duplicates', () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: '+1 555-1111', name: 'A' },
      { phone: '15551111', name: 'B' }, // same digits as #1
      { phone: '+1 555-2222', name: 'C' },
    ]);
    expect(unique.map((r) => r.name)).toEqual(['A', 'C']);
    expect(duplicates).toBe(1);
  });

  it('drops rows with no digits', () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: '   ' },
      { phone: '+1 555-3333' },
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe('findExistingContact', () => {
  // Minimal SupabaseClient stub: resolves the .from().select().eq().like()
  // chain, applying the suffix LIKE to the named column the way Postgres
  // would (`phone_normalized` is the generated digits-only column).
  function stubDb(rows: Array<{ id: string; phone: string }>): SupabaseClient {
    const builder = {
      select: () => builder,
      eq: () => builder,
      like: (column: string, pattern: string) => {
        const suffix = pattern.replace(/^%/, '');
        const value = (r: { phone: string }) =>
          column === 'phone_normalized' ? r.phone.replace(/\D/g, '') : r.phone;
        return Promise.resolve({
          data: rows.filter((r) => value(r).endsWith(suffix)),
          error: null,
        });
      },
    };
    return { from: () => builder } as unknown as SupabaseClient;
  }

  it('returns a trunk-variant match', async () => {
    const db = stubDb([{ id: 'c1', phone: '37063949836' }]);
    const hit = await findExistingContact(db, 'acct', '+370 063 949 836');
    expect(hit?.id).toBe('c1');
    const back = stubDb([{ id: 'c2', phone: '370063949836' }]);
    expect((await findExistingContact(back, 'acct', '37063949836'))?.id).toBe(
      'c2'
    );
  });

  it('finds a contact saved with a formatted phone (A1)', async () => {
    const db = stubDb([{ id: 'c1', phone: '+1 (809) 555-1234' }]);
    const hit = await findExistingContact(db, 'acct', '18095551234');
    expect(hit?.id).toBe('c1');
  });

  it('keeps numbers that only share the last 8 digits apart (A2)', async () => {
    const db = stubDb([{ id: 'c809', phone: '18095551234' }]);
    expect(await findExistingContact(db, 'acct', '18295551234')).toBeNull();
  });

  it('finds a national number saved without country code', async () => {
    const db = stubDb([{ id: 'c1', phone: '809-555-1234' }]);
    expect((await findExistingContact(db, 'acct', '18095551234'))?.id).toBe(
      'c1'
    );
  });

  it('a suffix only stands for a missing country code (1-3 digits)', async () => {
    // `555-1234` lacks area code AND country code: 809 and 829 would merge.
    const seven = stubDb([{ id: 'c7', phone: '555-1234' }]);
    expect(await findExistingContact(seven, 'acct', '18095551234')).toBeNull();
    const national = stubDb([{ id: 'c809', phone: '8095551234' }]);
    expect(
      await findExistingContact(national, 'acct', '18295551234')
    ).toBeNull();
    const both = stubDb([
      { id: 'c809', phone: '18095551234' },
      { id: 'c829', phone: '18295551234' },
    ]);
    expect(await findExistingContact(both, 'acct', '5551234')).toBeNull();
  });

  it('two equally good suffix candidates match neither', async () => {
    const db = stubDb([
      { id: 'us', phone: '12025551234' },
      { id: 'other', phone: '72025551234' },
    ]);
    expect(await findExistingContact(db, 'acct', '2025551234')).toBeNull();
  });

  it('Mexico 52/521 and Argentina 54/549 are the same mobile', async () => {
    const mx = stubDb([{ id: 'mx', phone: '+52 55 1234 5678' }]);
    expect((await findExistingContact(mx, 'acct', '5215512345678'))?.id).toBe(
      'mx'
    );
    const mx1 = stubDb([{ id: 'mx1', phone: '5215512345678' }]);
    expect((await findExistingContact(mx1, 'acct', '525512345678'))?.id).toBe(
      'mx1'
    );
    const ar = stubDb([{ id: 'ar', phone: '+54 11 2345 6789' }]);
    expect((await findExistingContact(ar, 'acct', '5491123456789'))?.id).toBe(
      'ar'
    );
  });

  it('a 52 number does not match another country sharing only the tail', async () => {
    const db = stubDb([{ id: 'uk', phone: '445512345678' }]);
    expect(await findExistingContact(db, 'acct', '5215512345678')).toBeNull();
  });

  it('prefers the exact match over a suffix match', async () => {
    const db = stubDb([
      { id: 'suffix', phone: '8095551234' },
      { id: 'exact', phone: '18095551234' },
    ]);
    expect((await findExistingContact(db, 'acct', '18095551234'))?.id).toBe(
      'exact'
    );
  });

  it('prefers the longest suffix', async () => {
    const db = stubDb([
      { id: 'short', phone: '95551234' },
      { id: 'long', phone: '8095551234' },
    ]);
    expect((await findExistingContact(db, 'acct', '18095551234'))?.id).toBe(
      'long'
    );
  });

  it('ignores a suffix shorter than 7 digits', async () => {
    const db = stubDb([{ id: 'c1', phone: '551234' }]);
    expect(await findExistingContact(db, 'acct', '18095551234')).toBeNull();
  });

  it('prefers the exact match over a trunk variant', async () => {
    const db = stubDb([
      { id: 'variant', phone: '370063949836' },
      { id: 'exact', phone: '37063949836' },
    ]);
    const hit = await findExistingContact(db, 'acct', '37063949836');
    expect(hit?.id).toBe('exact');
  });

  it('returns null when no candidate matches', async () => {
    const db = stubDb([{ id: 'c1', phone: '15559999999' }]);
    const hit = await findExistingContact(db, 'acct', '+1 555-123-4567');
    expect(hit).toBeNull();
  });

  it('returns null for an empty phone without querying', async () => {
    const db = stubDb([{ id: 'c1', phone: '15551234567' }]);
    expect(await findExistingContact(db, 'acct', '   ')).toBeNull();
  });
});
