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
 * Tables that carry `account_id` (migration 017 + later). A read of one
 * of these that is neither filtered by account nor keyed by a specific
 * row is a list, and a list has to name its account.
 */
const ACCOUNT_SCOPED = new Set([
  'accounts',
  'ai_configs',
  'ai_knowledge_documents',
  'ai_usage_log',
  'automation_logs',
  'automations',
  'broadcasts',
  'contact_notes',
  'contacts',
  'conversations',
  'custom_fields',
  'deals',
  'flow_runs',
  'flows',
  'member_presence',
  'message_templates',
  'notifications',
  'pipelines',
  'profiles',
  'quick_replies',
  'subscriptions',
  'tags',
  'usage_counters',
  'whatsapp_config',
]);

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

describe('every browser read of a tenant table names its account', () => {
  it('holds across the whole client bundle', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('@/lib/supabase/client')) continue;

      const re = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source))) {
        const table = m[1];
        if (!ACCOUNT_SCOPED.has(table)) continue; // child table — see below
        const chain = chainAt(source, m.index);
        // Writes are out of scope here — 057 widened SELECT policies
        // only, so RLS is still a one-account filter for them (and the
        // browser client refuses them outright during a session). That
        // includes `insert(...).select()`, which returns what it wrote.
        if (/\.(insert|update|upsert|delete)\(/.test(chain)) continue;
        if (!/\.select\(/.test(chain)) continue;
        if (/account_id/.test(chain)) continue;
        // Keyed reads are already one account's: the row id (or the
        // parent id) came from a list that was itself filtered.
        if (/\.(eq|in)\(\s*["'`]\w*_?id["'`]/.test(chain)) continue;

        const line = source.slice(0, m.index).split('\n').length;
        offenders.push(
          `${path.relative(process.cwd(), file)}:${line} — ${table}`
        );
      }
    }

    expect(offenders).toEqual([]);
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
    const at = sample.indexOf(".from('contacts')");
    const chain = chainAt(sample, at);

    expect(/account_id/.test(chain)).toBe(false);
    expect(/\.(eq|in)\(\s*["'`]\w*_?id["'`]/.test(chain)).toBe(false);
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
