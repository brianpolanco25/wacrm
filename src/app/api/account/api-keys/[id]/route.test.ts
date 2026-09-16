import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 7 §1 — revoking after the rotation grace window was introduced.
//
// Adding a future `revoked_at` created a state the revoke route did not know
// about: a key that is stamped but still live. Its old filter (`revoked_at IS
// NULL`) would have answered 404 for a whole day — exactly when an admin who
// just learned the key leaked needs the button to work. These tests pin the
// three outcomes: live → revoked, in-grace → revoked NOW, already dead → 404.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({ rows: [] as Row[], accountId: 'acct-a' }));

/**
 * `api_keys` double with just enough PostgREST to be honest: `eq`, `is`
 * and the one `or(...)` expression the route builds
 * (`revoked_at.is.null,revoked_at.gt.<iso>`). Parsing it for real is the
 * point — a no-op `or()` would let a wrong filter pass these tests.
 */
function fakeClient() {
  return {
    from(table: string) {
      if (table !== 'api_keys') throw new Error(`unexpected table ${table}`);
      const predicates: ((row: Row) => boolean)[] = [];
      let patch: Row | null = null;

      const parseTerm = (term: string) => (row: Row) => {
        const [column, op, ...rest] = term.split('.');
        const value = rest.join('.');
        const cell = row[column];
        if (op === 'is')
          return value === 'null' ? cell == null : cell === value;
        if (op === 'gt') return cell != null && String(cell) > value;
        throw new Error(`unsupported operator ${op}`);
      };

      const chain = {
        select: () => chain,
        update: (p: Row) => {
          patch = p;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          predicates.push((row) => row[column] === value);
          return chain;
        },
        is: (column: string, value: unknown) => {
          predicates.push((row) =>
            value === null ? row[column] == null : row[column] === value
          );
          return chain;
        },
        or: (expression: string) => {
          const terms = expression.split(',').map(parseTerm);
          predicates.push((row) => terms.some((t) => t(row)));
          return chain;
        },
        maybeSingle: async () => {
          const rows = h.rows.filter((r) => predicates.every((p) => p(r)));
          if (patch) for (const r of rows) Object.assign(r, patch);
          return {
            data: rows[0] ? { id: rows[0].id } : null,
            error: null,
          };
        },
      };
      return chain;
    },
  };
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: fakeClient(),
    accountId: h.accountId,
    userId: 'user-a',
  }),
  toErrorResponse: (err: unknown) => {
    throw err;
  },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { DELETE } from './route';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-15T10:00:00.000Z');

function revoke(id: string) {
  return DELETE(
    new Request(`https://crm.test/api/account/api-keys/${id}`, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(() => {
  h.rows = [];
  h.accountId = 'acct-a';
  __resetRateLimitForTests();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DELETE /api/account/api-keys/[id]', () => {
  it('revokes a live key', async () => {
    h.rows.push({ id: 'k1', account_id: 'acct-a', revoked_at: null });
    const res = await revoke('k1');
    expect(res.status).toBe(200);
    expect(h.rows[0].revoked_at).toBe(NOW.toISOString());
  });

  it('cuts short a rotation grace window instead of answering 404', async () => {
    h.rows.push({
      id: 'k1',
      account_id: 'acct-a',
      // Stamped by /rotate: still authenticating for another 23 h.
      revoked_at: new Date(NOW.getTime() + 23 * HOUR).toISOString(),
    });
    const res = await revoke('k1');
    expect(res.status).toBe(200);
    // Now, not in 23 hours.
    expect(h.rows[0].revoked_at).toBe(NOW.toISOString());
  });

  it('a key already dead is a 404 and is not re-stamped', async () => {
    const dead = new Date(NOW.getTime() - HOUR).toISOString();
    h.rows.push({ id: 'k1', account_id: 'acct-a', revoked_at: dead });
    const res = await revoke('k1');
    expect(res.status).toBe(404);
    expect(h.rows[0].revoked_at).toBe(dead);
  });

  it("another account's key is a 404 and is left alone", async () => {
    h.rows.push({ id: 'k1', account_id: 'acct-b', revoked_at: null });
    const res = await revoke('k1');
    expect(res.status).toBe(404);
    expect(h.rows[0].revoked_at).toBeNull();
  });
});
