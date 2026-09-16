import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 7 §1 — rotation with a 24 h grace window.
//
// The criterion from the spec: "rotating leaves two keys active for 24 h and
// the old one stops authenticating afterwards". Both halves are asserted
// against the REAL auth-path function (`findActiveKeyByHash`), not against a
// UI flag — the grace window only exists if the credential really still
// resolves, and really stops.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  accountId: 'acct-a',
  userId: 'user-a',
  seq: 0,
}));

/** Minimal `api_keys` table: eq / is filters, insert, update, delete. */
function fakeClient() {
  return {
    from(table: string) {
      if (table !== 'api_keys') throw new Error(`unexpected table ${table}`);
      const filters: { column: string; value: unknown }[] = [];
      let action: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row = {};
      // PostgREST projects to the requested columns; the fake does too,
      // so "key_hash never leaves the server" is a real assertion and
      // not an artefact of a lazy double.
      let projection: string[] | null = null;

      const project = (rows: Row[]): Row[] =>
        projection === null
          ? rows
          : rows.map((r) =>
              Object.fromEntries(
                projection!.filter((c) => c in r).map((c) => [c, r[c]])
              )
            );

      const hit = () =>
        h.rows.filter((r) => filters.every((f) => r[f.column] === f.value));

      const run = () => {
        if (action === 'insert') {
          const row: Row = {
            id: `key-${++h.seq}`,
            revoked_at: null,
            last_used_at: null,
            created_at: new Date().toISOString(),
            ...payload,
          };
          h.rows.push(row);
          return [row];
        }
        const rows = hit();
        if (action === 'update') {
          for (const r of rows) Object.assign(r, payload);
        }
        if (action === 'delete') {
          for (const r of rows) h.rows.splice(h.rows.indexOf(r), 1);
        }
        return rows;
      };

      const chain = {
        select: (cols?: string) => {
          if (typeof cols === 'string' && cols !== '*') {
            projection = cols.split(',').map((c) => c.trim());
          }
          return chain;
        },
        insert: (row: Row) => {
          action = 'insert';
          payload = row;
          return chain;
        },
        update: (patch: Row) => {
          action = 'update';
          payload = patch;
          return chain;
        },
        delete: () => {
          action = 'delete';
          return chain;
        },
        eq: (column: string, value: unknown) => {
          filters.push({ column, value });
          return chain;
        },
        is: (column: string, value: unknown) => {
          filters.push({ column, value });
          return chain;
        },
        or: () => chain,
        maybeSingle: async () => ({
          data: project(run())[0] ?? null,
          error: null,
        }),
        single: async () => {
          const rows = project(run());
          return rows[0]
            ? { data: rows[0], error: null }
            : { data: null, error: { message: 'no rows' } };
        },
        then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
          Promise.resolve({ data: project(run()), error: null }).then(resolve),
      };
      return chain;
    },
  };
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: fakeClient(),
    accountId: h.accountId,
    userId: h.userId,
  }),
  toErrorResponse: (err: unknown) => {
    throw err;
  },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => fakeClient(),
}));

import { hashApiKey } from '@/lib/api-keys/keys';
import { findActiveKeyByHash } from '@/lib/api-keys/store';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const HOUR = 60 * 60 * 1000;

function seedKey(overrides: Row = {}): Row {
  const row: Row = {
    id: `key-${++h.seq}`,
    account_id: h.accountId,
    created_by: h.userId,
    name: 'Zapier',
    key_prefix: 'wacrm_live_seed0000',
    key_hash: hashApiKey('wacrm_live_seedplaintextseedplaintext'),
    scopes: ['messages:send', 'contacts:read'],
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  h.rows.push(row);
  return row;
}

function rotate(id: string, body: unknown = {}) {
  return POST(
    new Request(`https://crm.test/api/account/api-keys/${id}/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(() => {
  h.rows = [];
  h.seq = 0;
  h.accountId = 'acct-a';
  h.userId = 'user-a';
  __resetRateLimitForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/account/api-keys/[id]/rotate', () => {
  it('mints a replacement with the same name and scopes, revealed once', async () => {
    const old = seedKey();
    const res = await rotate(old.id as string);
    expect(res.status).toBe(201);

    const payload = (await res.json()) as {
      key: Row;
      plaintext: string;
      previous: { id: string; revoked_at: string };
    };
    expect(payload.key.name).toBe('Zapier');
    expect(payload.key.scopes).toEqual(['messages:send', 'contacts:read']);
    expect(payload.plaintext).toMatch(/^wacrm_live_/);
    expect(payload.previous.id).toBe(old.id);

    // The plaintext is never persisted, only its hash — and it is a
    // different credential from the one it replaces.
    const created = h.rows.find((r) => r.id === payload.key.id)!;
    expect(created.key_hash).toBe(hashApiKey(payload.plaintext));
    expect(created.key_hash).not.toBe(old.key_hash);
    expect(JSON.stringify(payload.key)).not.toContain(payload.plaintext);
    expect(payload.key.key_hash).toBeUndefined();
  });

  it('leaves BOTH keys authenticating for 24 h, then only the new one', async () => {
    const oldPlaintext = 'wacrm_live_seedplaintextseedplaintext';
    const old = seedKey();
    const res = await rotate(old.id as string);
    const payload = (await res.json()) as { plaintext: string };

    // Right after rotating, both resolve.
    await expect(
      findActiveKeyByHash(hashApiKey(oldPlaintext))
    ).resolves.toMatchObject({ id: old.id });
    await expect(
      findActiveKeyByHash(hashApiKey(payload.plaintext))
    ).resolves.toBeTruthy();

    // 23 h in, the old one is still the customer's working credential.
    vi.setSystemTime(Date.now() + 23 * HOUR);
    await expect(
      findActiveKeyByHash(hashApiKey(oldPlaintext))
    ).resolves.toBeTruthy();

    // 25 h in, it is gone; the new one is unaffected.
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await expect(
      findActiveKeyByHash(hashApiKey(oldPlaintext))
    ).resolves.toBeNull();
    await expect(
      findActiveKeyByHash(hashApiKey(payload.plaintext))
    ).resolves.toBeTruthy();
  });

  it('stamps the old key exactly 24 h out', async () => {
    const old = seedKey();
    await rotate(old.id as string);
    const stamped = h.rows.find((r) => r.id === old.id)!;
    expect(new Date(stamped.revoked_at as string).getTime()).toBe(
      Date.now() + 24 * HOUR
    );
  });

  it('inherits the old expiry unless the caller asks for a new one', async () => {
    const expiry = new Date(Date.now() + 10 * 24 * HOUR).toISOString();
    const inherited = await rotate(
      (seedKey({ expires_at: expiry }).id as string) ?? ''
    );
    const a = (await inherited.json()) as { key: Row };
    expect(a.key.expires_at).toBe(expiry);

    const explicit = await rotate(seedKey().id as string, {
      expiresInDays: 30,
    });
    const b = (await explicit.json()) as { key: Row };
    expect(new Date(b.key.expires_at as string).getTime()).toBe(
      Date.now() + 30 * 24 * HOUR
    );
  });

  it("another account's key id is a 404 and nothing is created", async () => {
    const foreign = seedKey({ account_id: 'acct-b', name: 'Theirs' });
    const before = h.rows.length;
    const res = await rotate(foreign.id as string);
    expect(res.status).toBe(404);
    expect(h.rows).toHaveLength(before);
    expect(h.rows.find((r) => r.id === foreign.id)?.revoked_at).toBeNull();
  });

  it('a key already revoked for good is a 404, not a resurrection', async () => {
    const dead = seedKey({
      revoked_at: new Date(Date.now() - HOUR).toISOString(),
    });
    const res = await rotate(dead.id as string);
    expect(res.status).toBe(404);
    expect(h.rows).toHaveLength(1);
  });

  it('rotating twice does not push the old key’s deadline further out', async () => {
    const old = seedKey();
    await rotate(old.id as string);
    const firstDeadline = h.rows.find((r) => r.id === old.id)!.revoked_at;

    vi.setSystemTime(Date.now() + HOUR);
    await rotate(old.id as string);
    expect(h.rows.find((r) => r.id === old.id)!.revoked_at).toBe(firstDeadline);
  });
});
