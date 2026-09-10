/**
 * In-memory stand-in for a Supabase client, for the tenant-isolation
 * suite (`tenant-isolation.test.ts`).
 *
 * Why not the usual per-test chained mocks: those hand back whatever
 * the test author typed, so a route that forgets `.eq('account_id', …)`
 * still "passes" — the mock never had another tenant's rows to leak.
 * This fake evaluates the query for real against tables seeded with
 * BOTH accounts' data. Drop a filter and the other account's rows come
 * back, and the assertions catch it. That is the property the spec
 * asks for: removing an `account_id` filter from any service-role route
 * must fail the suite.
 *
 * Two clients come out of one database:
 *
 *   - `admin`  — the service role. No row-level filtering at all; every
 *                scope has to be written in the query, exactly like
 *                production.
 *   - `asUser` — the cookie-session (SSR) client. Applies a simulation of
 *                the RLS policies from migration 017: rows are visible
 *                when they belong to the caller's account, resolved
 *                through the parent for tables without `account_id`.
 *
 * Supported surface: `from().select/insert/update/delete/upsert`, the
 * common filters (`eq neq in is like ilike lt lte gt gte contains or`),
 * dotted filters on embedded relations, `order/limit/range`,
 * `single/maybeSingle`, `count: 'exact'` with `head`, PostgREST embeds
 * (`alias:table!inner(cols)`, nested), `rpc()`, `auth.getUser()` and a
 * `storage` stub. Column projection is not simulated — whole rows come
 * back, which no route under test depends on.
 */

export type Row = Record<string, unknown> & { id?: string };
export type Tables = Record<string, Row[]>;

export interface Actor {
  userId: string;
  accountId: string;
}

export interface QueryLogEntry {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | 'rpc';
  filters: { column: string; op: string; value: unknown }[];
  /** Account the SSR client ran as, or null for the service role. */
  rls: string | null;
}

type RpcHandler = (
  args: Record<string, unknown>,
  db: FakeDatabase
) => { data: unknown; error: { message: string } | null } | unknown;

interface Filter {
  column: string;
  op: string;
  value: unknown;
}

interface OrderSpec {
  column: string;
  ascending: boolean;
}

interface Embed {
  alias: string;
  table: string;
  inner: boolean;
  children: Embed[];
}

type Result = {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
};

// ------------------------------------------------------------------
// RLS simulation — which account does a row belong to?
// ------------------------------------------------------------------

const parentOf =
  (parentTable: string, fk: string) =>
  (row: Row, tables: Tables): string | null => {
    const parent = (tables[parentTable] ?? []).find((r) => r.id === row[fk]);
    return parent ? tenantOf(parentTable, parent, tables) : null;
  };

const TENANT_RESOLVERS: Record<
  string,
  (row: Row, tables: Tables) => string | null
> = {
  accounts: (row) => (row.id as string) ?? null,
  messages: parentOf('conversations', 'conversation_id'),
  message_reactions: parentOf('conversations', 'conversation_id'),
  contact_tags: parentOf('contacts', 'contact_id'),
  flow_nodes: parentOf('flows', 'flow_id'),
  automation_steps: parentOf('automations', 'automation_id'),
  broadcast_recipients: parentOf('broadcasts', 'broadcast_id'),
  flow_run_events: parentOf('flow_runs', 'flow_run_id'),
  ai_knowledge_chunks: parentOf('ai_knowledge_documents', 'document_id'),
};

export function tenantOf(
  table: string,
  row: Row,
  tables: Tables
): string | null {
  const resolver = TENANT_RESOLVERS[table];
  if (resolver) return resolver(row, tables);
  return typeof row.account_id === 'string' ? row.account_id : null;
}

// ------------------------------------------------------------------
// Select-clause parsing (embeds)
// ------------------------------------------------------------------

function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseEmbeds(select: string): Embed[] {
  const embeds: Embed[] = [];
  for (const token of splitTopLevel(select, ',')) {
    const open = token.indexOf('(');
    if (open === -1) continue;
    const head = token.slice(0, open).trim();
    const inner = token.slice(open + 1, token.lastIndexOf(')'));
    let alias: string;
    let table: string;
    const colon = head.indexOf(':');
    if (colon !== -1) {
      alias = head.slice(0, colon).trim();
      table = head.slice(colon + 1).trim();
    } else {
      alias = head;
      table = head;
    }
    const innerJoin = table.endsWith('!inner');
    if (innerJoin) table = table.slice(0, -'!inner'.length);
    if (alias.endsWith('!inner')) alias = alias.slice(0, -'!inner'.length);
    embeds.push({
      alias: alias.trim(),
      table: table.trim(),
      inner: innerJoin,
      children: parseEmbeds(inner),
    });
  }
  return embeds;
}

function singular(table: string): string {
  if (table.endsWith('ies')) return table.slice(0, -3) + 'y';
  if (table.endsWith('s')) return table.slice(0, -1);
  return table;
}

// ------------------------------------------------------------------
// Filter evaluation
// ------------------------------------------------------------------

function getPath(row: Row, path: string): unknown {
  // PostgREST JSON extraction, e.g. `payload->>meta_message_id`.
  // Resolve it before dotted relation traversal so flow-event queries use
  // the same predicate as the real client.
  const jsonPath = path.match(/^(.+?)->>([^>]+)$/);
  if (jsonPath) {
    const value = getPath(row, jsonPath[1]);
    return value && typeof value === 'object'
      ? (value as Row)[jsonPath[2]]
      : undefined;
  }
  const parts = path.split('.');
  let cur: unknown = row;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      // Dotted filter on a one-to-many embed: collect the values.
      return cur.map((r) => (r as Row)[part]);
    }
    cur = (cur as Row)[part];
  }
  return cur;
}

function likeToRegex(pattern: string, flags: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/\*/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, flags);
}

function compare(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'is':
      return expected === null
        ? actual === null || actual === undefined
        : actual === expected;
    case 'like':
      return (
        typeof actual === 'string' &&
        likeToRegex(String(expected), '').test(actual)
      );
    case 'ilike':
      return (
        typeof actual === 'string' &&
        likeToRegex(String(expected), 'i').test(actual)
      );
    case 'lt':
      return (
        actual !== undefined &&
        actual !== null &&
        (actual as number) < (expected as number)
      );
    case 'lte':
      return (
        actual !== undefined &&
        actual !== null &&
        (actual as number) <= (expected as number)
      );
    case 'gt':
      return (
        actual !== undefined &&
        actual !== null &&
        (actual as number) > (expected as number)
      );
    case 'gte':
      return (
        actual !== undefined &&
        actual !== null &&
        (actual as number) >= (expected as number)
      );
    case 'contains':
      return (
        Array.isArray(actual) &&
        Array.isArray(expected) &&
        expected.every((v) => actual.includes(v))
      );
    default:
      throw new Error(`fake-supabase: unsupported filter operator "${op}"`);
  }
}

function matches(row: Row, filter: Filter): boolean {
  const actual = getPath(row, filter.column);
  if (Array.isArray(actual) && filter.column.includes('.')) {
    // Dotted filter over a one-to-many embed: any element may match.
    return actual.some((v) => compare(v, filter.op, filter.value));
  }
  return compare(actual, filter.op, filter.value);
}

/** Parse a PostgREST `.or()` string: `a.eq.1,b.is.null,and(c.lt.2,d.eq.3)`. */
function parseOrExpression(expr: string): (row: Row) => boolean {
  const clauses = splitTopLevel(expr, ',').map(parseClause);
  return (row) => clauses.some((c) => c(row));
}

function parseClause(clause: string): (row: Row) => boolean {
  if (clause.startsWith('and(') && clause.endsWith(')')) {
    const inner = splitTopLevel(clause.slice(4, -1), ',').map(parseClause);
    return (row) => inner.every((c) => c(row));
  }
  if (clause.startsWith('or(') && clause.endsWith(')')) {
    return parseOrExpression(clause.slice(3, -1));
  }
  const first = clause.indexOf('.');
  const second = clause.indexOf('.', first + 1);
  const column = clause.slice(0, first);
  const op = clause.slice(first + 1, second);
  const raw = clause.slice(second + 1);
  let value: unknown = raw;
  if (raw === 'null') value = null;
  else if (raw === 'true') value = true;
  else if (raw === 'false') value = false;
  return (row) => compare(getPath(row, column), op, value);
}

// ------------------------------------------------------------------
// Database
// ------------------------------------------------------------------

export class FakeDatabase {
  readonly tables: Tables;
  readonly log: QueryLogEntry[] = [];
  readonly rpcHandlers: Record<string, RpcHandler>;
  /** Objects written through `storage.from().upload()`. */
  readonly storageObjects: { bucket: string; path: string }[] = [];
  private counter = 0;

  constructor(seed: Tables, rpcHandlers: Record<string, RpcHandler> = {}) {
    this.tables = {};
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((r) => ({ ...r }));
    }
    this.rpcHandlers = rpcHandlers;
  }

  /** Service-role client: no row filtering. */
  get admin(): FakeClient {
    return new FakeClient(this, null);
  }

  /** Cookie-session client for `actor`, with RLS simulated. */
  asUser(actor: Actor): FakeClient {
    return new FakeClient(this, actor);
  }

  rows(table: string): Row[] {
    if (!this.tables[table]) this.tables[table] = [];
    return this.tables[table];
  }

  nextId(table: string): string {
    this.counter += 1;
    return `${table}-new-${this.counter}`;
  }

  /** Deep copy of every row that belongs to `accountId` — for "unchanged" checks. */
  snapshot(accountId: string): Record<string, Row[]> {
    const out: Record<string, Row[]> = {};
    for (const [table, rows] of Object.entries(this.tables)) {
      out[table] = rows
        .filter((r) => tenantOf(table, r, this.tables) === accountId)
        .map((r) => JSON.parse(JSON.stringify(r)) as Row);
    }
    return out;
  }

  /** Ids of every row that belongs to `accountId`, across all tables. */
  idsOf(accountId: string): Set<string> {
    const ids = new Set<string>();
    for (const [table, rows] of Object.entries(this.tables)) {
      for (const r of rows) {
        if (
          typeof r.id === 'string' &&
          tenantOf(table, r, this.tables) === accountId
        ) {
          ids.add(r.id);
        }
      }
    }
    return ids;
  }
}

export class FakeClient {
  constructor(
    readonly db: FakeDatabase,
    readonly actor: Actor | null
  ) {}

  from(table: string): FakeQuery {
    return new FakeQuery(this.db, table, this.actor);
  }

  rpc(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    this.db.log.push({
      table: `rpc:${name}`,
      op: 'rpc',
      filters: [],
      rls: this.actor?.accountId ?? null,
    });
    const handler = this.db.rpcHandlers[name];
    if (!handler) return Promise.resolve({ data: null, error: null });
    const out = handler(args, this.db);
    if (out && typeof out === 'object' && 'error' in (out as object)) {
      return Promise.resolve(out as Result);
    }
    return Promise.resolve({ data: out, error: null });
  }

  readonly auth = {
    getUser: async () =>
      this.actor
        ? { data: { user: { id: this.actor.userId } }, error: null }
        : { data: { user: null }, error: { message: 'no session' } },
  };

  readonly storage = {
    from: (bucket: string) => ({
      upload: async (path: string) => {
        this.db.storageObjects.push({ bucket, path });
        return { data: { path }, error: null };
      },
      getPublicUrl: (path: string) => ({
        data: {
          publicUrl: `https://fake.supabase.co/storage/v1/object/public/${bucket}/${path}`,
        },
      }),
      download: async (path: string) => {
        const known = this.db.storageObjects.some(
          (o) => o.bucket === bucket && o.path === path
        );
        return known
          ? { data: new Blob(['bytes'], { type: 'image/png' }), error: null }
          : { data: null, error: { message: 'Object not found' } };
      },
      createSignedUrl: async (path: string) => ({
        data: {
          signedUrl: `https://fake.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=x`,
        },
        error: null,
      }),
      remove: async () => ({ data: null, error: null }),
    }),
  };
}

type Mutation =
  | { kind: 'insert'; rows: Row[] }
  | { kind: 'update'; values: Row }
  | { kind: 'delete' }
  | {
      kind: 'upsert';
      rows: Row[];
      onConflict: string[];
      ignoreDuplicates: boolean;
    };

export class FakeQuery implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private orClauses: ((row: Row) => boolean)[] = [];
  private orders: OrderSpec[] = [];
  private limitN: number | null = null;
  private rangeSpec: [number, number] | null = null;
  private embeds: Embed[] = [];
  private wantsSelect = false;
  private countMode: 'exact' | null = null;
  private headOnly = false;
  private mutation: Mutation | null = null;
  private terminal: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(
    private readonly db: FakeDatabase,
    private readonly table: string,
    private readonly actor: Actor | null
  ) {}

  // ---- builders ---------------------------------------------------

  select(columns = '*', opts: { count?: 'exact'; head?: boolean } = {}): this {
    this.wantsSelect = true;
    this.embeds = parseEmbeds(columns);
    if (opts.count) this.countMode = opts.count;
    if (opts.head) this.headOnly = true;
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.mutation = {
      kind: 'insert',
      rows: Array.isArray(rows) ? rows : [rows],
    };
    return this;
  }

  update(values: Row): this {
    this.mutation = { kind: 'update', values };
    return this;
  }

  delete(): this {
    this.mutation = { kind: 'delete' };
    return this;
  }

  upsert(
    rows: Row | Row[],
    opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  ): this {
    this.mutation = {
      kind: 'upsert',
      rows: Array.isArray(rows) ? rows : [rows],
      onConflict: (opts.onConflict ?? 'id').split(',').map((s) => s.trim()),
      ignoreDuplicates: opts.ignoreDuplicates ?? false,
    };
    return this;
  }

  private add(op: string, column: string, value: unknown): this {
    this.filters.push({ column, op, value });
    return this;
  }
  eq(c: string, v: unknown): this {
    return this.add('eq', c, v);
  }
  neq(c: string, v: unknown): this {
    return this.add('neq', c, v);
  }
  in(c: string, v: unknown[]): this {
    return this.add('in', c, v);
  }
  is(c: string, v: unknown): this {
    return this.add('is', c, v);
  }
  like(c: string, v: string): this {
    return this.add('like', c, v);
  }
  ilike(c: string, v: string): this {
    return this.add('ilike', c, v);
  }
  lt(c: string, v: unknown): this {
    return this.add('lt', c, v);
  }
  lte(c: string, v: unknown): this {
    return this.add('lte', c, v);
  }
  gt(c: string, v: unknown): this {
    return this.add('gt', c, v);
  }
  gte(c: string, v: unknown): this {
    return this.add('gte', c, v);
  }
  contains(c: string, v: unknown[]): this {
    return this.add('contains', c, v);
  }
  filter(c: string, op: string, v: unknown): this {
    return this.add(op, c, v);
  }
  or(expr: string): this {
    this.orClauses.push(parseOrExpression(expr));
    return this;
  }
  order(column: string, opts: { ascending?: boolean } = {}): this {
    this.orders.push({ column, ascending: opts.ascending ?? true });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number): this {
    this.rangeSpec = [from, to];
    return this;
  }
  single(): this {
    this.terminal = 'single';
    return this;
  }
  maybeSingle(): this {
    this.terminal = 'maybeSingle';
    return this;
  }

  // ---- execution --------------------------------------------------

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private visible(row: Row): boolean {
    if (!this.actor) return true;
    return tenantOf(this.table, row, this.db.tables) === this.actor.accountId;
  }

  private embed(row: Row, embeds: Embed[], parentTable: string): Row | null {
    const out: Row = { ...row };
    for (const e of embeds) {
      const fkCandidates = [
        `${e.alias}_id`,
        `${singular(e.table)}_id`,
        `${e.table}_id`,
      ];
      const fk = fkCandidates.find((k) => k in row);
      if (fk) {
        const target =
          this.db.rows(e.table).find((r) => r.id === row[fk]) ?? null;
        const embedded = target
          ? this.embed(target, e.children, e.table)
          : null;
        if (e.inner && !embedded) return null;
        out[e.alias] = embedded;
      } else {
        const childFks = [`${singular(parentTable)}_id`, `${parentTable}_id`];
        const children = this.db
          .rows(e.table)
          .filter((r) => childFks.some((k) => r[k] === row.id))
          .map((r) => this.embed(r, e.children, e.table))
          .filter((r): r is Row => r !== null);
        if (e.inner && children.length === 0) return null;
        out[e.alias] = children;
      }
    }
    return out;
  }

  private selectRows(): Row[] {
    let rows = this.db
      .rows(this.table)
      .filter((r) => this.visible(r))
      .map((r) => this.embed(r, this.embeds, this.table))
      .filter((r): r is Row => r !== null);
    rows = rows.filter(
      (r) =>
        this.filters.every((f) => matches(r, f)) &&
        this.orClauses.every((c) => c(r))
    );
    for (const o of [...this.orders].reverse()) {
      rows.sort((a, b) => {
        const av = a[o.column] as string | number | null;
        const bv = b[o.column] as string | number | null;
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av < bv ? -1 : 1) * (o.ascending ? 1 : -1);
      });
    }
    if (this.rangeSpec)
      rows = rows.slice(this.rangeSpec[0], this.rangeSpec[1] + 1);
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private stampNew(row: Row): Row {
    const now = new Date().toISOString();
    return {
      id: this.db.nextId(this.table),
      created_at: now,
      updated_at: now,
      ...row,
    };
  }

  private rlsViolation(row: Row): Result | null {
    if (!this.actor) return null;
    const tenant = tenantOf(this.table, row, this.db.tables);
    if (tenant !== this.actor.accountId) {
      return {
        data: null,
        error: {
          message: `new row violates row-level security policy for table "${this.table}"`,
          code: '42501',
        },
      };
    }
    return null;
  }

  private execute(): Result {
    this.db.log.push({
      table: this.table,
      op: this.mutation?.kind ?? 'select',
      filters: [...this.filters],
      rls: this.actor?.accountId ?? null,
    });

    let affected: Row[];
    const m = this.mutation;
    if (!m) {
      affected = this.selectRows();
      if (this.countMode) {
        return {
          data: this.headOnly ? null : affected,
          error: null,
          count: affected.length,
        };
      }
    } else if (m.kind === 'insert') {
      affected = [];
      for (const r of m.rows) {
        const row = this.stampNew(r);
        const violation = this.rlsViolation(row);
        if (violation) return violation;
        this.db.rows(this.table).push(row);
        affected.push(row);
      }
    } else if (m.kind === 'upsert') {
      affected = [];
      for (const r of m.rows) {
        const existing = this.db
          .rows(this.table)
          .find((e) => m.onConflict.every((c) => e[c] === r[c]));
        if (existing) {
          if (m.ignoreDuplicates) continue;
          Object.assign(existing, r);
          affected.push(existing);
        } else {
          const row = this.stampNew(r);
          const violation = this.rlsViolation(row);
          if (violation) return violation;
          this.db.rows(this.table).push(row);
          affected.push(row);
        }
      }
    } else if (m.kind === 'update') {
      const targets = this.selectRows();
      const targetIds = new Set(targets.map((t) => t.id));
      affected = [];
      for (const row of this.db.rows(this.table)) {
        if (targetIds.has(row.id)) {
          Object.assign(row, m.values);
          affected.push(row);
        }
      }
    } else {
      const targets = this.selectRows();
      const targetIds = new Set(targets.map((t) => t.id));
      affected = this.db.rows(this.table).filter((r) => targetIds.has(r.id));
      this.db.tables[this.table] = this.db
        .rows(this.table)
        .filter((r) => !targetIds.has(r.id));
    }

    if (m && !this.wantsSelect) return { data: null, error: null };

    if (this.terminal === 'single') {
      if (affected.length !== 1) {
        return {
          data: null,
          error: {
            message: `JSON object requested, multiple (or no) rows returned (${affected.length})`,
            code: 'PGRST116',
          },
        };
      }
      return { data: affected[0], error: null };
    }
    if (this.terminal === 'maybeSingle') {
      if (affected.length > 1) {
        return {
          data: null,
          error: { message: 'multiple rows returned', code: 'PGRST116' },
        };
      }
      return { data: affected[0] ?? null, error: null };
    }
    return { data: affected, error: null };
  }
}

/**
 * A client whose every call is forwarded to whatever database is current
 * at call time. Module-level admin clients are cached for the life of
 * the process (`let _adminClient`), so the mocks hand out one of these
 * and the suite swaps the database underneath between tests.
 */
export function forwardingClient(current: () => FakeClient): FakeClient {
  return {
    from: (table: string) => current().from(table),
    rpc: (name: string, args?: Record<string, unknown>) =>
      current().rpc(name, args),
    auth: { getUser: () => current().auth.getUser() },
    storage: { from: (bucket: string) => current().storage.from(bucket) },
  } as unknown as FakeClient;
}
