import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acct' }) }));

import {
  fetchBroadcastRecipients,
  resolveAudience,
} from './use-broadcast-sending';

// p16.6 F2 (audit-lean 1): audience and recipient reads page past
// PostgREST's 1000-row cap, `.in()` lists are chunked, and a failed
// exclusion read aborts instead of sending to excluded contacts.

type Row = Record<string, unknown>;
type Tables = Record<string, Row[] | { error: string }>;

/**
 * Chainable fake of the PostgREST builder: applies `eq` / `in` filters,
 * caps any read at 1000 rows like the real server, honours `.range()`.
 */
function fakeSupabase(tables: Tables) {
  const inSizes: number[] = [];
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let window: [number, number] | null = null;
    const run = () => {
      const src = tables[table];
      if (!Array.isArray(src))
        return { data: null, error: { message: src.error } };
      const rows = src.filter((r) => filters.every((f) => f(r)));
      const [a, b] = window ?? [0, 999];
      return { data: rows.slice(a, Math.min(b + 1, a + 1000)), error: null };
    };
    const builder = {
      select: () => builder,
      order: () => builder,
      eq: (col: string, v: unknown) => {
        filters.push((r) => r[col] === v);
        return builder;
      },
      in: (col: string, vs: unknown[]) => {
        inSizes.push(vs.length);
        filters.push((r) => vs.includes(r[col]));
        return builder;
      },
      insert: (rows: Row[]) => ({
        select: () =>
          Promise.resolve({
            data: rows.map((r, i) => ({ id: `new${i}`, ...r })),
            error: null,
          }),
      }),
      range: (a: number, b: number) => {
        window = [a, b];
        return Promise.resolve(run());
      },
      then: (ok: (v: ReturnType<typeof run>) => unknown) =>
        Promise.resolve(run()).then(ok),
    };
    return builder;
  };
  const auth = {
    getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }),
  };
  return { client: { from, auth } as never, inSizes };
}

const contacts = Array.from({ length: 2500 }, (_, i) => ({
  id: `c${i}`,
  account_id: 'acct',
}));

describe('resolveAudience', () => {
  it('audience "all" with 2 500 contacts resolves all 2 500', async () => {
    const { client } = fakeSupabase({ contacts });
    const out = await resolveAudience(client, 'acct', { type: 'all' });
    expect(out).toHaveLength(2500);
    expect(new Set(out.map((c) => c.id)).size).toBe(2500);
  });

  it('a row re-read across pages is sent once', async () => {
    // A contact inserted between pages shifts the offset: c999 comes back
    // as the first row of page 2.
    const shifted = [
      ...contacts.slice(0, 1000),
      contacts[999],
      ...contacts.slice(1000),
    ];
    const { client } = fakeSupabase({ contacts: shifted });
    const out = await resolveAudience(client, 'acct', { type: 'all' });
    expect(out).toHaveLength(2500);
    expect(out.filter((c) => c.id === 'c999')).toHaveLength(1);
  });

  it('a CSV of 1 200 phones looks them up in chunks of at most 500', async () => {
    const { client, inSizes } = fakeSupabase({ contacts: [] });
    const csvContacts = Array.from({ length: 1200 }, (_, i) => ({
      phone: `1809${String(i).padStart(7, '0')}`,
    }));
    const out = await resolveAudience(client, 'acct', {
      type: 'csv',
      csvContacts,
    });
    expect(out).toHaveLength(1200);
    expect(inSizes).toEqual([500, 500, 200]);
  });

  it('a tag with 2 500 members resolves 2 500, chunking the .in(id)', async () => {
    const contact_tags = contacts.map((c, i) => ({
      id: `ct${i}`,
      contact_id: c.id,
      tag_id: 't1',
    }));
    const { client, inSizes } = fakeSupabase({ contacts, contact_tags });
    const out = await resolveAudience(client, 'acct', {
      type: 'tags',
      tagIds: ['t1'],
    });
    expect(out).toHaveLength(2500);
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(500);
  });

  it('excludes every member of an excluded tag with more than 1000', async () => {
    const contact_tags = contacts
      .slice(0, 1500)
      .map((c, i) => ({ id: `ct${i}`, contact_id: c.id, tag_id: 'vip' }));
    const { client } = fakeSupabase({ contacts, contact_tags });
    const out = await resolveAudience(client, 'acct', {
      type: 'all',
      excludeTagIds: ['vip'],
    });
    expect(out).toHaveLength(1000);
  });

  it('throws when the exclusion read fails, so nothing is sent', async () => {
    const { client } = fakeSupabase({
      contacts,
      contact_tags: { error: 'boom' },
    });
    await expect(
      resolveAudience(client, 'acct', { type: 'all', excludeTagIds: ['vip'] })
    ).rejects.toThrow('Failed to fetch excluded contacts: boom');
  });
});

describe('fetchBroadcastRecipients', () => {
  it('re-reads all 2 500 recipient rows', async () => {
    const broadcast_recipients = contacts.map((c, i) => ({
      id: `r${i}`,
      broadcast_id: 'b1',
      contact: c,
    }));
    const { client } = fakeSupabase({ broadcast_recipients });
    expect(await fetchBroadcastRecipients(client, 'b1')).toHaveLength(2500);
  });
});
