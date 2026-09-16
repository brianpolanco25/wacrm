// ============================================================
// Test double for the `api_idempotency_keys` table.
//
// Test-only, in the same spirit as `src/lib/security/fake-supabase.ts`:
// nothing in the application imports it. It exists because the one
// behaviour that matters in `withIdempotency` is the UNIQUE index doing
// the arbitration — "who reserved the key first" — and a `vi.fn()` that
// always answers `{ error: null }` would let the double-send bug this
// module exists to prevent pass every test.
//
// So this fake enforces `UNIQUE (api_key_id, idempotency_key)` for real
// and returns Postgres' `23505` when it is violated, exactly as
// PostgREST does. Everything else is the minimum query surface the
// module uses: eq / lt filters, maybeSingle, insert, update, delete.
// ============================================================

type Row = Record<string, unknown>;

interface Filter {
  op: 'eq' | 'lt';
  column: string;
  value: unknown;
}

interface Result {
  data: unknown;
  error: { message: string; code?: string } | null;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === 'eq') return row[f.column] === f.value;
    return String(row[f.column]) < String(f.value);
  });
}

export class FakeIdempotencyStore {
  readonly rows: Row[] = [];
  /** Every query the fake saw, so a test can assert the account scope. */
  readonly seen: { action: string; filters: Filter[] }[] = [];
  private seq = 0;
  /** Flip to make the next write fail, for the degraded-store paths. */
  failNextWrite: { message: string; code?: string } | null = null;

  from(table: string) {
    if (table !== 'api_idempotency_keys') {
      throw new Error(`FakeIdempotencyStore: unexpected table '${table}'`);
    }
    return this.builder();
  }

  private builder() {
    // Arrow functions throughout so `this` stays the store without an
    // alias (the repo's eslint config forbids `const self = this`).
    const filters: Filter[] = [];
    let action: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};

    const run = (): Result => {
      this.seen.push({ action, filters: [...filters] });

      if (action === 'insert') {
        const failure = this.failNextWrite;
        if (failure) {
          this.failNextWrite = null;
          return { data: null, error: failure };
        }
        const clash = this.rows.some(
          (r) =>
            r.api_key_id === payload.api_key_id &&
            r.idempotency_key === payload.idempotency_key
        );
        if (clash) {
          return {
            data: null,
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "api_idempotency_keys_key_idx"',
            },
          };
        }
        this.rows.push({
          id: `idem-${++this.seq}`,
          response_status: null,
          response_body: null,
          created_at: new Date().toISOString(),
          ...payload,
        });
        return { data: null, error: null };
      }

      const hit = this.rows.filter((r) => matches(r, filters));

      if (action === 'update') {
        const failure = this.failNextWrite;
        if (failure) {
          this.failNextWrite = null;
          return { data: null, error: failure };
        }
        for (const row of hit) Object.assign(row, payload);
        return { data: hit, error: null };
      }

      if (action === 'delete') {
        for (const row of hit) {
          this.rows.splice(this.rows.indexOf(row), 1);
        }
        return { data: null, error: null };
      }

      return { data: hit, error: null };
    };

    const chain = {
      select: () => chain,
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
        filters.push({ op: 'eq', column, value });
        return chain;
      },
      lt: (column: string, value: unknown) => {
        filters.push({ op: 'lt', column, value });
        return chain;
      },
      maybeSingle: async (): Promise<Result> => {
        const res = run();
        const rows = (res.data as Row[] | null) ?? [];
        return { data: rows[0] ?? null, error: res.error };
      },
      then: (resolve: (r: Result) => unknown) =>
        Promise.resolve(run()).then(resolve),
    };
    return chain;
  }
}
