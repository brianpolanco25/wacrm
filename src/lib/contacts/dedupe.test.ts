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
