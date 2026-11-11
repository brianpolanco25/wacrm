// Test-only in-memory stand-in for the service-role client: enough of
// the supabase-js query builder for the voice module, applying the
// filters it receives to an array of rows so a cross-account leak test
// can assert on what was actually read and written.

type Row = Record<string, unknown>;
export interface RecordedQuery {
  table: string;
  op: 'select' | 'update' | 'insert';
  payload?: Row;
  filters: [string, string, unknown][];
}

export function fakeDb(
  tables: Record<string, Row[]>,
  opts: {
    updateError?: { message: string } | null;
    selectError?: { message: string } | null;
  } = {}
) {
  const queries: RecordedQuery[] = [];

  function builder(table: string) {
    const q: RecordedQuery = { table, op: 'select', filters: [] };
    let limit = Infinity;
    const rows = () =>
      (tables[table] ?? []).filter((r) =>
        q.filters.every(([op, col, val]) => {
          const v = r[col];
          if (op === 'eq') return v === val;
          if (op === 'is')
            return v === val || (val === null && v === undefined);
          if (op === 'gte') return String(v) >= String(val);
          return true;
        })
      );
    const run = () => {
      if (q.op === 'update') {
        if (opts.updateError) return { data: null, error: opts.updateError };
        const hit = rows();
        for (const r of hit) Object.assign(r, q.payload);
        return { data: hit, error: null };
      }
      if (q.op === 'insert') {
        (tables[table] ??= []).push({ ...q.payload });
        return { data: null, error: null };
      }
      if (opts.selectError) return { data: null, error: opts.selectError };
      return { data: rows().slice(0, limit), error: null };
    };
    const b = {
      select: () => b,
      update: (payload: Row) => {
        q.op = 'update';
        q.payload = payload;
        return b;
      },
      insert: (payload: Row) => {
        q.op = 'insert';
        q.payload = payload;
        queries.push(q);
        return Promise.resolve(run());
      },
      eq: (col: string, val: unknown) => (q.filters.push(['eq', col, val]), b),
      is: (col: string, val: unknown) => (q.filters.push(['is', col, val]), b),
      gte: (col: string, val: unknown) => (
        q.filters.push(['gte', col, val]),
        b
      ),
      limit: (n: number) => ((limit = n), b),
      maybeSingle: async () => {
        queries.push(q);
        const r = run();
        return {
          data: r.data ? ((r.data as Row[])[0] ?? null) : null,
          error: r.error,
        };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        queries.push(q);
        return Promise.resolve(run()).then(res, rej);
      },
    };
    return b;
  }

  const db = {
    from: (table: string) => builder(table),
    storage: {
      from: () => ({ download: async () => ({ data: null, error: null }) }),
    },
  };
  return { db, queries, tables };
}
