import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  supportAccountFromFlag,
  supportFlagAccountId,
  supportFlagValue,
} from '@/lib/auth/support-cookie';
import { effectiveAccountId } from '@/hooks/use-auth';

// ============================================================
// What the browser is looking at during a support session.
//
// Migration 057 widened every SELECT policy to "my accounts OR the one I
// have an open support session on". That made the customer's data
// readable — and, at the same time, stopped RLS from being a filter for
// ONE account. An unfiltered `select()` from the browser now comes back
// with the operator's rows AND the customer's, interleaved and
// indistinguishable, under a banner naming only the customer. A query
// filtered by the operator's own account comes back with the wrong
// company entirely.
//
// The fix has two halves, and this file pins both:
//
//   1. the browser learns WHICH account it is showing (the support flag
//      cookie carries the impersonated `account_id`);
//   2. every list in the panel filters by it.
// ============================================================

const OPERATOR_ACCOUNT = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CUSTOMER_ACCOUNT = 'bbbbbbbb-0000-4000-8000-00000000000b';

describe('the support flag cookie', () => {
  it('carries the impersonated account, and nothing else reads as one', () => {
    expect(
      supportFlagAccountId(
        `theme=dark; wacrm_support_active=${CUSTOMER_ACCOUNT}`
      )
    ).toBe(CUSTOMER_ACCOUNT);
    expect(supportFlagAccountId('theme=dark')).toBeNull();
  });

  it('is not fooled by a cookie whose name merely ends the same way', () => {
    expect(
      supportFlagValue(`not_wacrm_support_active=${CUSTOMER_ACCOUNT}`)
    ).toBeNull();
  });

  it('refuses a value that is not a uuid, while still reporting a session', () => {
    // Both questions matter and they are NOT the same: "is there a
    // session?" (yes — the flag is there) and "which account?" (no idea).
    // A caller that collapsed them would fall back to the operator's own
    // account, which is the mislabelled view all over again.
    expect(supportFlagValue('wacrm_support_active=1')).toBe('1');
    expect(supportAccountFromFlag('1')).toBeNull();
    expect(supportAccountFromFlag('../../etc/passwd')).toBeNull();
    expect(supportAccountFromFlag(CUSTOMER_ACCOUNT)).toBe(CUSTOMER_ACCOUNT);
  });
});

describe('effectiveAccountId', () => {
  it('is the impersonated account while the session lasts', () => {
    expect(effectiveAccountId(OPERATOR_ACCOUNT, CUSTOMER_ACCOUNT)).toBe(
      CUSTOMER_ACCOUNT
    );
  });

  it("is the operator's own once the session is gone", () => {
    expect(effectiveAccountId(OPERATOR_ACCOUNT, null)).toBe(OPERATOR_ACCOUNT);
  });

  it('fails closed when the flag is there but names no account', () => {
    // Not `OPERATOR_ACCOUNT`: showing the operator's own rows under the
    // customer's banner is the exact failure this exists to prevent.
    expect(effectiveAccountId(OPERATOR_ACCOUNT, 'nonsense')).toBeNull();
  });

  it('stays null for a signed-out browser', () => {
    expect(effectiveAccountId(null, null)).toBeNull();
  });
});

// ------------------------------------------------------------
// The merged list, replayed against a fake that behaves like the widened
// RLS: both companies' rows are visible, and only the query's own
// filters narrow them.
// ------------------------------------------------------------

interface Row {
  id: string;
  account_id: string;
  name: string;
}

/** Contacts of two companies, as post-057 RLS would hand them over. */
const SEED: Row[] = [
  { id: 'c1', account_id: OPERATOR_ACCOUNT, name: 'Mine 1' },
  { id: 'c2', account_id: OPERATOR_ACCOUNT, name: 'Mine 2' },
  { id: 'c3', account_id: CUSTOMER_ACCOUNT, name: "Customer's 1" },
];

/** What the pages chain onto a `from()`, and nothing more. */
interface FakeBuilder extends PromiseLike<{
  data: Row[];
  count: number;
  error: null;
}> {
  select(columns?: string, opts?: { count?: string }): FakeBuilder;
  order(column?: string, opts?: { ascending?: boolean }): FakeBuilder;
  range(from?: number, to?: number): FakeBuilder;
  eq(column: string, value: string): FakeBuilder;
}

/**
 * The thinnest PostgREST stand-in that can tell the two queries apart:
 * it applies `.eq()` and returns `count` the way supabase-js does.
 */
function fakeSupabase(rows: Row[]) {
  return {
    from(): FakeBuilder {
      const filters: [string, string][] = [];
      const builder: FakeBuilder = {
        select: () => builder,
        order: () => builder,
        range: () => builder,
        eq: (column: string, value: string) => {
          filters.push([column, value]);
          return builder;
        },
        then: (resolve) => {
          const data = rows.filter((r) =>
            filters.every(
              ([c, v]) => (r as unknown as Record<string, string>)[c] === v
            )
          );
          return Promise.resolve({
            data,
            count: data.length,
            error: null,
          }).then(resolve);
        },
      };
      return builder;
    },
  };
}

describe('the contacts list during a support session', () => {
  it('shows only the customer, not both companies merged', async () => {
    const supabase = fakeSupabase(SEED);

    // The exact chain `contacts/page.tsx` makes, with the effective
    // account id `useAuth()` now hands it.
    const { data, count } = await supabase
      .from()
      .select('*', { count: 'exact' })
      .eq('account_id', effectiveAccountId(OPERATOR_ACCOUNT, CUSTOMER_ACCOUNT)!)
      .order('created_at', { ascending: false })
      .range(0, 24);

    expect(data.map((r) => r.name)).toEqual(["Customer's 1"]);
    // The paginator's total has to be the customer's too — it used to be
    // the sum of both companies.
    expect(count).toBe(1);
  });

  it('would show three rows from two companies without the filter', async () => {
    // Guards the test above from becoming vacuous: the fake really does
    // hand over both accounts, exactly as the widened RLS does.
    const supabase = fakeSupabase(SEED);
    const { data } = await supabase
      .from()
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(0, 24);

    expect(data).toHaveLength(3);
    expect(new Set(data.map((r) => r.account_id)).size).toBe(2);
  });

  it("shows the operator's own contacts again once the session ends", async () => {
    const supabase = fakeSupabase(SEED);
    const { data } = await supabase
      .from()
      .select('*', { count: 'exact' })
      .eq('account_id', effectiveAccountId(OPERATOR_ACCOUNT, null)!)
      .order('created_at', { ascending: false })
      .range(0, 24);

    expect(data.map((r) => r.name)).toEqual(['Mine 1', 'Mine 2']);
  });
});

// ------------------------------------------------------------
// The regression net: no browser list may go back to trusting RLS as its
// account filter.
// ------------------------------------------------------------

/**
 * Tables that carry `account_id`, read off the migrations themselves.
 *
 * This used to be a list written by hand, and it was already wrong: it
 * was missing seven tables that do have the column (`account_invitations`,
 * `ai_knowledge_chunks`, `api_keys`, `automation_pending_executions`,
 * `impersonation_log`, `inbound_auto_replies`, `webhook_endpoints`).
 * None of them is read from the browser today, so the audit still
 * happened to be right — but the first list built on `account_invitations`
 * would have sailed through unfiltered and in silence, which is the one
 * thing this net exists to stop.
 *
 * Grep, not a SQL parser: the repo adds no dependency for this, and the
 * two shapes the migrations actually use are both regular.
 *
 *   1. `ALTER TABLE <t> ADD COLUMN [IF NOT EXISTS] account_id …` — how
 *      migration 017 retrofitted tenancy onto everything that predates it;
 *   2. `CREATE TABLE [IF NOT EXISTS] <t> ( … account_id … )` — how every
 *      table created afterwards declares it.
 *
 * `accounts` is seeded by hand because it is the one table whose OWN `id`
 * is the account: a read of it must be keyed by that id, and the same
 * "this is a list, name your account" rule applies.
 */
function accountScopedTables(): Set<string> {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  const tables = new Set(['accounts']);

  for (const file of fs.readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    let m: RegExpExecArray | null;

    const altered =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?account_id\b/gi;
    while ((m = altered.exec(sql))) tables.add(m[1].toLowerCase());

    const created =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(/gi;
    while ((m = created.exec(sql))) {
      // The column list, matched by parens so a nested `numeric(10,2)`
      // or a CHECK doesn't cut it short.
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let close = open;
      for (let i = open; i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      // Anchored to the start of a line so `contact_id` or a REFERENCES
      // clause elsewhere in the body can't be mistaken for the column.
      if (/^\s*account_id\b/m.test(sql.slice(open, close))) {
        tables.add(m[1].toLowerCase());
      }
    }
  }
  return tables;
}

const ACCOUNT_SCOPED = accountScopedTables();

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The chain that starts at `.from(` — up to the end of the statement. */
function chainAt(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth <= 0 && (c === ';' || c === '\n')) {
      if (c === ';') return source.slice(start, i);
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] !== '.') return source.slice(start, i);
    }
  }
  return source.slice(start);
}

/**
 * A chain names its account when `account_id` is the ARGUMENT of an `.eq`
 * or `.in`, not merely a substring of it somewhere.
 *
 * The looser `/account_id/.test(chain)` this replaces had a hole wide
 * enough to drive the original bug back through:
 * `from('contacts').select('id, account_id, name').order(…)` — a list that
 * only SELECTS the column — passed the audit in silence.
 */
const FILTERS_BY_ACCOUNT = /\.(eq|in)\(\s*["'`]account_id["'`]/;

/**
 * Every column a chain narrows itself by, in `.eq` / `.in` order.
 */
function filteredColumns(chain: string): string[] {
  return [...chain.matchAll(/\.(?:eq|in)\(\s*["'`]([a-z_]+)["'`]/g)].map(
    (m) => m[1]
  );
}

/**
 * A read keyed by a specific row (`id`) or by a parent row
 * (`contact_id`, `conversation_id`, …) is already one account's: that id
 * came off a list this same audit forces to name its account.
 *
 * `user_id` explicitly does NOT count, and that is the second hole being
 * closed here. The old exemption was `["'`]\w*_?id["'`]`, which matched it
 * — so a list narrowed only to the current user looked "keyed" and skated
 * past, while during a support session the current user is the OPERATOR.
 * It is the exact shape `tag-manager.tsx` and `template-manager.tsx` had
 * to be fixed out of by hand this round.
 */
function isKeyedRead(chain: string): boolean {
  return filteredColumns(chain).some(
    (col) => col !== 'user_id' && col !== 'account_id' && /(^|_)id$/.test(col)
  );
}

/**
 * The two reads that legitimately narrow by `user_id` alone: both fetch
 * the signed-in user's OWN row, which is what they are for. Pinned by
 * file so a third one has to be argued for here rather than appear.
 */
const OWN_USER_ROW_READS = [
  'src/hooks/use-auth.tsx', // the operator's own profile (account_id, role)
  'src/lib/storage/upload-media.ts', // their own avatar path
];

/** Every `.from(table).select(…)` a browser file makes, table by table. */
function browserSelects(): {
  file: string;
  line: number;
  table: string;
  chain: string;
}[] {
  const found: { file: string; line: number; table: string; chain: string }[] =
    [];
  for (const file of walk(SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('@/lib/supabase/client')) continue;

    const re = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const chain = chainAt(source, m.index);
      // Writes are out of scope here — 057 widened SELECT policies
      // only, so RLS is still a one-account filter for them (and the
      // browser client refuses them outright during a session). That
      // includes `insert(...).select()`, which returns what it wrote.
      if (/\.(insert|update|upsert|delete)\(/.test(chain)) continue;
      if (!/\.select\(/.test(chain)) continue;
      found.push({
        file: path.relative(process.cwd(), file),
        line: source.slice(0, m.index).split('\n').length,
        table: m[1],
        chain,
      });
    }
  }
  return found;
}

describe('the tenant tables the audit works from', () => {
  it('are read off supabase/migrations, not off a list kept by hand', () => {
    // A hand-kept list drifts silently: the one this replaced was
    // missing all seven of these, every one of which really does carry
    // account_id in the schema.
    for (const table of [
      'account_invitations',
      'ai_knowledge_chunks',
      'api_keys',
      'automation_pending_executions',
      'impersonation_log',
      'inbound_auto_replies',
      'webhook_endpoints',
    ]) {
      expect(ACCOUNT_SCOPED.has(table)).toBe(true);
    }
    // Both declaration shapes are picked up: `contacts` got the column
    // by ALTER in 017, `notifications` was created with it in 027.
    expect(ACCOUNT_SCOPED.has('contacts')).toBe(true);
    expect(ACCOUNT_SCOPED.has('notifications')).toBe(true);
  });

  it('leave out the child tables, which have no account of their own', () => {
    // Not an oversight — see the `child tables` block at the bottom.
    // If one of these ever showed up here it would mean a migration gave
    // it an account_id and the justification below went stale.
    for (const table of [
      'messages',
      'message_reactions',
      'contact_tags',
      'contact_custom_values',
      'pipeline_stages',
      'broadcast_recipients',
      'flow_nodes',
      'automation_steps',
    ]) {
      expect(ACCOUNT_SCOPED.has(table)).toBe(false);
    }
  });
});

describe('every browser SELECT of a tenant table names its account', () => {
  it('holds for every `.from(table).select(…)` in the client bundle', () => {
    const offenders = browserSelects()
      .filter((q) => ACCOUNT_SCOPED.has(q.table))
      .filter((q) => !FILTERS_BY_ACCOUNT.test(q.chain))
      .filter((q) => !isKeyedRead(q.chain))
      .filter((q) => !OWN_USER_ROW_READS.includes(q.file))
      .map((q) => `${q.file}:${q.line} — ${q.table}`);

    expect(offenders).toEqual([]);
  });

  it('lists the reads narrowed only by the current user, all of them own-row', () => {
    // During a support session "the current user" is the operator, so
    // `user_id` is not an account filter. These two are the user's own
    // row on purpose; anything else appearing here is a bug.
    const userOnly = browserSelects()
      .filter((q) => ACCOUNT_SCOPED.has(q.table))
      .filter((q) => !FILTERS_BY_ACCOUNT.test(q.chain))
      .filter((q) => !isKeyedRead(q.chain))
      .filter((q) => filteredColumns(q.chain).includes('user_id'))
      .map((q) => q.file);

    expect([...new Set(userOnly)].sort()).toEqual(
      [...OWN_USER_ROW_READS].sort()
    );
  });

  it('would catch the query that caused this round', () => {
    // The literal chain `contacts/page.tsx` used to make. Kept here so
    // the audit above cannot quietly stop detecting anything.
    const sample = `
      import { createClient } from '@/lib/supabase/client'
      const { data } = await supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);
    `;
    const chain = chainAt(sample, sample.indexOf(".from('contacts')"));

    expect(FILTERS_BY_ACCOUNT.test(chain)).toBe(false);
    expect(isKeyedRead(chain)).toBe(false);
  });

  it('would catch a list that merely selects the account_id column', () => {
    // The hole in the old `/account_id/.test(chain)`: reading the column
    // is not filtering by it.
    const chain = chainAt(
      `.from('contacts').select('id, account_id, name').order('created_at');`,
      0
    );

    expect(chain).toContain('account_id');
    expect(FILTERS_BY_ACCOUNT.test(chain)).toBe(false);
    expect(isKeyedRead(chain)).toBe(false);
  });

  it('would catch a list narrowed only to the current user', () => {
    // The hole in the old `\\w*_?id` exemption: `user_id` looked like a
    // key. It is the operator's id during a support session.
    const chain = chainAt(`.from('tags').select('*').eq('user_id', uid);`, 0);

    expect(FILTERS_BY_ACCOUNT.test(chain)).toBe(false);
    expect(isKeyedRead(chain)).toBe(false);
  });

  it('still lets a genuinely keyed read through', () => {
    const chain = chainAt(
      `.from('conversations').select('*').eq('id', convId).maybeSingle();`,
      0
    );

    expect(isKeyedRead(chain)).toBe(true);
  });
});

// ------------------------------------------------------------
// The other half of the same invariant: realtime.
//
// `select()` is not the only way this panel reads from Supabase in the
// browser. Every `postgres_changes` subscription used to go out with no
// `filter:` at all, trusting RLS to decide which rows it would hear
// about — the very assumption 057 ended. The replication stream handed
// the operator's own rows to a tab showing the customer's: a
// conversation of the operator's company dropped into the customer's
// inbox live, and both badges counted two companies.
// ------------------------------------------------------------

/** The options literal of every `postgres_changes` subscription in `source`. */
function subscriptions(
  source: string
): { line: number; table: string | null; options: string }[] {
  const found: { line: number; table: string | null; options: string }[] = [];
  const re = /\.on\(\s*["'`]postgres_changes["'`]\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    // The next `{` is the options object. Found by scanning rather than
    // by regex because a comment can sit between the two (one does, in
    // `use-realtime.ts`).
    const open = source.indexOf('{', m.index + m[0].length);
    if (open === -1) continue;
    let depth = 0;
    let close = open;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          close = i + 1;
          break;
        }
      }
    }
    const options = source.slice(open, close);
    found.push({
      line: source.slice(0, m.index).split('\n').length,
      table: /table:\s*["'`]([a-z_]+)["'`]/.exec(options)?.[1] ?? null,
      options,
    });
  }
  return found;
}

/** `filter: \`account_id=eq.${…}\`` — the server-side half of the fix. */
const SUBSCRIBES_BY_ACCOUNT = /filter:\s*["'`][^"'`]*account_id=eq\./;

function browserSubscriptions(): {
  file: string;
  line: number;
  table: string | null;
  options: string;
}[] {
  const found = [];
  for (const file of walk(SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('@/lib/supabase/client')) continue;
    for (const sub of subscriptions(source)) {
      found.push({ file: path.relative(process.cwd(), file), ...sub });
    }
  }
  return found;
}

describe('every browser subscription to a tenant table names its account', () => {
  it('holds for every `postgres_changes` channel in the client bundle', () => {
    const offenders = browserSubscriptions()
      .filter((s) => s.table !== null && ACCOUNT_SCOPED.has(s.table))
      .filter((s) => !SUBSCRIBES_BY_ACCOUNT.test(s.options))
      .map((s) => `${s.file}:${s.line} — ${s.table}`);

    expect(offenders).toEqual([]);
  });

  it('finds the subscriptions at all, comments in the way included', () => {
    // Guards the assertion above from being vacuously empty: these are
    // the four that carry the filter, and `use-realtime.ts` has a
    // comment block sitting between the event name and the options.
    const scoped = browserSubscriptions()
      .filter((s) => s.table !== null && ACCOUNT_SCOPED.has(s.table))
      .map((s) => `${s.file} — ${s.table}`)
      .sort();

    expect(scoped).toEqual([
      'src/app/(dashboard)/notifications/page.tsx — notifications',
      'src/hooks/use-presence.ts — member_presence',
      'src/hooks/use-realtime.ts — conversations',
      'src/hooks/use-total-unread.ts — conversations',
      'src/hooks/use-unread-notifications.ts — notifications',
    ]);
  });

  it('would catch the unfiltered subscription this round removed', () => {
    // The literal options object `use-realtime.ts` used to pass.
    const before = `{ event: "*", schema: "public", table: "conversations" }`;
    expect(SUBSCRIBES_BY_ACCOUNT.test(before)).toBe(false);

    const after = `{ event: "*", schema: "public", table: "conversations", filter: \`account_id=eq.\${accountId}\` }`;
    expect(SUBSCRIBES_BY_ACCOUNT.test(after)).toBe(true);
  });

  it('accounts for the subscriptions to tables with no account_id', () => {
    // Neither a server filter nor a row check is available on these two;
    // they reach the account through their parent, and so does the code
    // that consumes their events:
    //
    //  - `messages` (use-realtime.ts) goes out unfiltered on purpose. A
    //    message for a conversation the (account-filtered) inbox does not
    //    know about is handed to `hydrateConversation`, which reads the
    //    row `.eq("account_id", accountId)` and finds nothing for another
    //    company's — so the event dies there.
    //  - `message_reactions` (message-thread.tsx) is already filtered by
    //    `conversation_id`, and that id came off the filtered inbox.
    const unscoped = browserSubscriptions()
      .filter((s) => s.table === null || !ACCOUNT_SCOPED.has(s.table))
      .map((s) => `${s.file} — ${s.table}`);

    expect([...new Set(unscoped)].sort()).toEqual([
      'src/components/inbox/message-thread.tsx — message_reactions',
      'src/hooks/use-realtime.ts — messages',
    ]);

    for (const sub of browserSubscriptions()) {
      if (sub.table !== 'message_reactions') continue;
      expect(sub.options).toMatch(/filter:\s*["'`][^"'`]*conversation_id=eq\./);
    }
  });
});

/**
 * Child tables (`contact_tags`, `contact_custom_values`, `messages`,
 * `message_reactions`, `broadcast_recipients`, `pipeline_stages`,
 * `automation_steps`, `flow_nodes`) have no `account_id` column at all —
 * they reach the account through their parent. Every read of one in this
 * panel is keyed by that parent id (`contact_id`, `conversation_id`,
 * `pipeline_id`, `broadcast_id`), and those ids come from lists that the
 * audit above already forces to name their account. Adding a filter they
 * cannot answer was not an option; this is the justification for leaving
 * them out.
 */
describe('child tables', () => {
  it('are reached through a parent id, which is where the account comes from', () => {
    const source = fs.readFileSync(
      path.join(SRC, 'components/inbox/contact-sidebar.tsx'),
      'utf8'
    );
    for (const table of ['deals', 'contact_notes', 'contact_tags']) {
      const at = source.indexOf(`.from("${table}")`);
      expect(at).toBeGreaterThan(-1);
      expect(chainAt(source, at)).toMatch(/\.eq\(\s*"contact_id"/);
    }
  });
});
