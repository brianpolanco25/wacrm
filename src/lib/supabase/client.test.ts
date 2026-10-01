import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// What the browser client may write during a support session.
//
// s9.5: a support session writes the tenant tables migration 072 opened
// (`SUPPORT_WRITABLE_TABLES`), and nothing else — not `profiles` or
// `notifications` (the OPERATOR'S own rows), not `accounts`, not rpc, not
// storage. What follows is the history of why the guard exists at all.
//
// This is the hole the first round of f4.4 left open, and it is the one
// that mattered: `middleware.ts` only ever sees requests that go through
// Next, and most of this panel does not. `contacts/page.tsx` deletes with
// `supabase.from('contacts').delete().in('id', ids)` straight from the
// browser; the tag manager inserts; the deal settings update `accounts`.
// Those requests carry the OPERATOR'S own JWT to `*.supabase.co`, so RLS
// runs them against the OPERATOR'S own account — meaning an operator could
// delete their own company's contacts while an amber banner said "Nothing
// you do here is saved".
//
// No jsdom in this repo (and no new deps), so `document.cookie` is stubbed
// directly: the guard only ever reads that one string.
// ============================================================

const h = vi.hoisted(() => ({
  /** Calls that reached the real client — must stay empty when blocked. */
  reached: [] as string[],
}));

vi.mock('@supabase/ssr', () => ({
  createBrowserClient: () => ({
    from(relation: string) {
      const builder: Record<string, unknown> = {};
      for (const method of [
        'select',
        'insert',
        'update',
        'upsert',
        'delete',
        'eq',
        'in',
      ]) {
        builder[method] = (...args: unknown[]) => {
          h.reached.push(`${relation}.${method}(${JSON.stringify(args)})`);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: 'row-1' }], error: null }).then(resolve);
      return builder;
    },
    // Reads `this` like supabase-js does (`this.rest.rpc(…)`), so a guard
    // that called it unbound would fail here and not only in a browser.
    rpcTag: 'rpc',
    rpc(this: { rpcTag: string }, name: string) {
      h.reached.push(`${this.rpcTag}:${name}`);
      return Promise.resolve({ data: [], error: null });
    },
    auth: {
      getUser: async () => ({ data: { user: { id: 'operator-1' } } }),
    },
    storage: {
      from(bucket: string) {
        const api: Record<string, unknown> = {};
        for (const method of [
          'upload',
          'remove',
          'move',
          'copy',
          'createSignedUploadUrl',
          'createSignedUrl',
          'download',
          'list',
        ]) {
          api[method] = async (...args: unknown[]) => {
            h.reached.push(
              `storage:${bucket}.${method}(${JSON.stringify(args)})`
            );
            return { data: { path: 'p' }, error: null };
          };
        }
        api.getPublicUrl = (path: string) => {
          h.reached.push(`storage:${bucket}.getPublicUrl(${path})`);
          return { data: { publicUrl: `https://cdn/${path}` } };
        };
        return api;
      },
      createBucket: async () => {
        h.reached.push('storage:createBucket');
        return { data: null, error: null };
      },
    },
  }),
}));

const { SUPPORT_ACTIVE_COOKIE } = await import('@/lib/auth/support-cookie');
const { SUPPORT_BLOCKED_RPCS, SUPPORT_READ_RPCS } =
  await import('@/lib/auth/support-scope');
const {
  createClient,
  endSupportSession,
  supportSessionAccountId,
  supportSessionActive,
} = await import('./client');

const SRC = path.join(process.cwd(), 'src');
const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations');
const CONTACTS_PAGE = path.join(
  SRC,
  'app',
  '(dashboard)',
  'contacts',
  'page.tsx'
);

/** The account a support session names — the flag cookie's value. */
const CUSTOMER = 'bbbbbbbb-0000-4000-8000-00000000000b';

function setCookies(value: string) {
  (globalThis as { document?: { cookie: string } }).document = {
    cookie: value,
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  h.reached = [];
  setCookies('');
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  vi.unstubAllGlobals();
});

describe('supportSessionActive', () => {
  it('is false with no cookies at all, and outside a browser', () => {
    expect(supportSessionActive()).toBe(false);
    delete (globalThis as { document?: unknown }).document;
    expect(supportSessionActive()).toBe(false);
  });

  it('is true only for the flag the server sets', () => {
    setCookies('theme=dark; other_cookie=1');
    expect(supportSessionActive()).toBe(false);
    setCookies(`theme=dark; ${SUPPORT_ACTIVE_COOKIE}=${CUSTOMER}`);
    expect(supportSessionActive()).toBe(true);
  });

  it('is not fooled by a cookie whose name merely ends the same way', () => {
    setCookies(`not_${SUPPORT_ACTIVE_COOKIE}=${CUSTOMER}`);
    expect(supportSessionActive()).toBe(false);
  });
});

describe('supportSessionAccountId', () => {
  it('is the account the flag names — the one every list filters by', () => {
    setCookies(`theme=dark; ${SUPPORT_ACTIVE_COOKIE}=${CUSTOMER}`);
    expect(supportSessionAccountId()).toBe(CUSTOMER);
  });

  it('is null with no session, and outside a browser', () => {
    setCookies('theme=dark');
    expect(supportSessionAccountId()).toBeNull();
    delete (globalThis as { document?: unknown }).document;
    expect(supportSessionAccountId()).toBeNull();
  });

  it('refuses a flag that does not name an account, while still reporting the session', () => {
    setCookies(`${SUPPORT_ACTIVE_COOKIE}=1`);
    expect(supportSessionActive()).toBe(true);
    expect(supportSessionAccountId()).toBeNull();
  });
});

describe('the browser client during a support session', () => {
  beforeEach(() => setCookies(`${SUPPORT_ACTIVE_COOKIE}=${CUSTOMER}`));

  it('lets the delete contacts/page.tsx makes through — the session writes (s9.5)', async () => {
    const supabase = createClient();

    const { error } = await supabase
      .from('contacts')
      .delete()
      .in('id', ['c1', 'c2']);

    expect(error).toBeNull();
    expect(h.reached).toContain('contacts.delete([])');
  });

  it.each(['insert', 'update', 'upsert', 'delete'])(
    'lets %s through on a table the session may write',
    async (op) => {
      const supabase = createClient();
      const builder = supabase.from('tags') as unknown as Record<
        string,
        (...a: unknown[]) => { select: () => PromiseLike<{ error: unknown }> }
      >;

      const { error } = await builder[op]({ name: 'x' }).select();
      expect(error).toBeNull();
      expect(h.reached[0]).toMatch(new RegExp(`^tags\\.${op}\\(`));
    }
  );

  it.each([
    'profiles',
    'notifications',
    'accounts',
    'api_keys',
    'account_invitations',
  ])('refuses writes to %s, and keeps the chain refusing', async (table) => {
    // profiles / notifications are keyed by auth.uid(): during a session
    // they are the OPERATOR'S own rows under the customer's banner.
    const supabase = createClient();
    for (const op of ['insert', 'update', 'upsert', 'delete']) {
      const builder = supabase.from(table) as unknown as Record<
        string,
        (...a: unknown[]) => {
          eq: (...a: unknown[]) => PromiseLike<{ error: unknown }>;
        }
      >;
      const { error } = await builder[op]({ x: 1 }).eq('id', 'r1');
      expect(error).toMatchObject({ code: 'support_session_forbidden' });
    }
    expect(h.reached).toEqual([]);
  });

  it('refuses the profile save profile-form.tsx makes', async () => {
    const supabase = createClient();
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: 'Not the operator' })
      .eq('user_id', 'operator-1');
    expect(error).toMatchObject({ code: 'support_session_forbidden' });
    expect(h.reached).toEqual([]);
  });

  it('runs filter_contacts_by_tags — a STABLE, SECURITY INVOKER read (s9.13)', async () => {
    const supabase = createClient();
    const { data, error } = await (supabase.rpc('filter_contacts_by_tags', {
      p_tag_ids: ['t1'],
      p_search: null,
      p_limit: 25,
      p_offset: 0,
    }) as unknown as PromiseLike<{ data: unknown; error: unknown }>);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(h.reached).toEqual(['rpc:filter_contacts_by_tags']);
  });

  it.each(['touch_presence', 'some_function_nobody_listed'])(
    'refuses rpc %s — only the read-only allow-list runs',
    async (name) => {
      // touch_presence is SECURITY DEFINER and upserts member_presence for
      // auth.uid(): the OPERATOR'S own presence. An unlisted name is
      // refused by default, whatever it does.
      const supabase = createClient();
      const { error } = await (supabase.rpc(name, {
        p_status: 'online',
      }) as unknown as PromiseLike<{ error: unknown }>);
      expect(error).toMatchObject({ code: 'support_session_forbidden' });
      expect(h.reached).toEqual([]);
    }
  );

  it('keeps the allow-list and the block-list apart', () => {
    for (const name of SUPPORT_READ_RPCS) {
      expect(SUPPORT_BLOCKED_RPCS.has(name), name).toBe(false);
    }
  });

  it('lets the tag filter of contacts/page.tsx through, with the call the page makes', async () => {
    // The bug s9.13 fixes: filtering contacts by tag during a session
    // used to land on "Failed to load contacts". No jsdom here, so the
    // call is lifted off the page itself and replayed through the client.
    const source = fs.readFileSync(CONTACTS_PAGE, 'utf8');
    const call =
      /supabase\.rpc\(\s*['"`]([a-z_0-9]+)['"`]\s*,\s*\{([^}]*)\}/.exec(source);
    expect(call, 'contacts/page.tsx no longer calls an rpc').not.toBeNull();
    const [, name, body] = call!;
    expect(name).toBe('filter_contacts_by_tags');
    const args = Object.fromEntries(
      [...body.matchAll(/(p_[a-z_]+)\s*:/g)].map((m) => [m[1], null])
    );
    expect(Object.keys(args)).toEqual([
      'p_tag_ids',
      'p_search',
      'p_limit',
      'p_offset',
    ]);

    const supabase = createClient();
    const { error } = await (supabase.rpc(
      name,
      args
    ) as unknown as PromiseLike<{
      error: unknown;
    }>);
    expect(error).toBeNull();
    expect(h.reached).toEqual([`rpc:${name}`]);

    // The RPC takes no account; during a session RLS answers with the
    // operator's companies too. The page keeps only the effective
    // account's rows (see checks_support-readonly-rpcs.sql, case 5).
    expect(source).toMatch(
      /\.map\(\(r\) => r\.contact\)\s*\.filter\(\(c\) => c\.account_id === accountId\)/
    );
  });

  it('leaves reads alone — looking is the entire point', async () => {
    const supabase = createClient();
    const { data, error } = await supabase.from('contacts').select('id');
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 'row-1' }]);
    expect(h.reached).toContain('contacts.select(["id"])');
  });

  it('still lets auth through — the operator has to be able to sign out', async () => {
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    expect(data.user?.id).toBe('operator-1');
  });

  // ----------------------------------------------------------
  // Storage. `profile-form.tsx` uploads the avatar BEFORE updating
  // `profiles`, so while storage slipped through the guard a support
  // session wrote the object for real and only then had the row update
  // refused: an orphan in the bucket and a half-saved form, under a
  // banner promising nothing was being saved.
  // ----------------------------------------------------------

  it.each(['upload', 'remove', 'move', 'copy', 'createSignedUploadUrl'])(
    'refuses storage.%s — uploads stay out of a support session',
    async (op) => {
      const supabase = createClient();
      const bucket = supabase.storage.from('avatars') as unknown as Record<
        string,
        (...a: unknown[]) => PromiseLike<{ error: unknown }>
      >;

      const { error } = await bucket[op]('some/path', new Blob());
      expect(error).toMatchObject({ code: 'support_session_forbidden' });
      expect(h.reached).toEqual([]);
    }
  );

  it('refuses the avatar upload profile-form.tsx makes, before it can orphan an object', async () => {
    const supabase = createClient();
    const { error } = await supabase.storage
      .from('avatars')
      .upload('operator-1/avatar.png', new Blob(), { upsert: true });

    expect(error).toMatchObject({ code: 'support_session_forbidden' });
    expect(h.reached).toEqual([]);
  });

  it('still signs urls — attachments are what the operator came to see', async () => {
    const supabase = createClient();
    const { error } = await supabase.storage
      .from('media')
      .createSignedUrl('acct/msg.jpg', 60);

    expect(error).toBeNull();
    expect(h.reached).toContain(
      'storage:media.createSignedUrl(["acct/msg.jpg",60])'
    );
  });

  it('leaves the other read operations alone', async () => {
    const supabase = createClient();
    await supabase.storage.from('media').download('acct/msg.jpg');
    await supabase.storage.from('media').list('acct');
    const { data } = supabase.storage.from('avatars').getPublicUrl('a/b.png');

    expect(data.publicUrl).toBe('https://cdn/a/b.png');
    expect(h.reached).toHaveLength(3);
  });

  it('refuses bucket administration too', async () => {
    const supabase = createClient();
    const { error } = await (supabase.storage.createBucket(
      'anything'
    ) as unknown as PromiseLike<{ error: unknown }>);

    expect(error).toMatchObject({ code: 'support_session_forbidden' });
    expect(h.reached).toEqual([]);
  });
});

describe('the browser client with no support session', () => {
  it('runs any rpc exactly as before', async () => {
    const supabase = createClient();
    const { error } = await (supabase.rpc('touch_presence', {
      p_status: 'online',
    }) as unknown as PromiseLike<{ error: unknown }>);
    expect(error).toBeNull();
    expect(h.reached).toEqual(['rpc:touch_presence']);
  });

  it('writes exactly as before', async () => {
    const supabase = createClient();
    const { error } = await supabase.from('contacts').delete().in('id', ['c1']);

    expect(error).toBeNull();
    expect(h.reached).toContain('contacts.delete([])');
  });

  it('uploads exactly as before', async () => {
    const supabase = createClient();
    const { error } = await supabase.storage
      .from('avatars')
      .upload('u/avatar.png', new Blob());

    expect(error).toBeNull();
    expect(h.reached.some((c) => c.startsWith('storage:avatars.upload'))).toBe(
      true
    );
  });
});

describe('endSupportSession', () => {
  it('does nothing at all when there is no session', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await endSupportSession();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks the server to stop the session before signing out', async () => {
    setCookies(`${SUPPORT_ACTIVE_COOKIE}=${CUSTOMER}`);
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);

    await endSupportSession();

    expect(fetchSpy).toHaveBeenCalledWith('/api/platform/impersonate/stop', {
      method: 'POST',
    });
  });

  it('never blocks the sign-out when the network is gone', async () => {
    setCookies(`${SUPPORT_ACTIVE_COOKIE}=${CUSTOMER}`);
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await expect(endSupportSession()).resolves.toBeUndefined();
  });
});

// ============================================================
// s9.13 — no browser rpc goes undecided.
//
// The guard is an allow-list, so a new `rpc('…')` in browser code would be
// refused during a support session without anybody having chosen that.
// These tests make the choice explicit: every name the browser calls is in
// SUPPORT_READ_RPCS or SUPPORT_BLOCKED_RPCS, and every name allowed is,
// in its latest migration, a STABLE, SECURITY INVOKER function that writes
// nothing.
// ============================================================

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

/** Every `.rpc(` in a file that uses the browser client, by name. */
function browserRpcCalls(): {
  file: string;
  line: number;
  name: string | null;
}[] {
  const found: { file: string; line: number; name: string | null }[] = [];
  for (const file of walk(SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('@/lib/supabase/client')) continue;
    if (file === path.join(SRC, 'lib', 'supabase', 'client.ts')) continue;
    // Strip comments so a doc line mentioning `rpc('x')` is not a call.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(
        /(^|[^:])\/\/.*$/gm,
        (c, p) => p + ' '.repeat(c.length - p.length)
      );
    const re = /\.rpc\(\s*(?:(['"`])([a-z_0-9]+)\1)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      found.push({
        file: path.relative(process.cwd(), file),
        line: code.slice(0, m.index).split('\n').length,
        name: m[2] ?? null,
      });
    }
  }
  return found;
}

/** The body of the LAST migration that (re)defines `public.<name>`. */
function latestDefinition(name: string): { file: string; sql: string } | null {
  let latest: { file: string; sql: string } | null = null;
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const source = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const re = new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`,
      'gi'
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const open = source.indexOf('$$', m.index);
      const close = source.indexOf('$$', open + 2);
      latest = { file, sql: source.slice(m.index, close + 2) };
    }
  }
  return latest;
}

describe('every rpc the browser makes is decided (s9.13)', () => {
  const calls = browserRpcCalls();

  it('finds the calls it is meant to police', () => {
    const names = calls.map((c) => c.name);
    expect(names).toContain('filter_contacts_by_tags');
    expect(names).toContain('touch_presence');
  });

  it('names each function literally, so it can be decided', () => {
    const dynamic = calls.filter((c) => c.name === null);
    expect(dynamic, JSON.stringify(dynamic)).toEqual([]);
  });

  it('puts each one in SUPPORT_READ_RPCS or SUPPORT_BLOCKED_RPCS', () => {
    const undecided = calls.filter(
      (c) =>
        c.name !== null &&
        !SUPPORT_READ_RPCS.has(c.name) &&
        !SUPPORT_BLOCKED_RPCS.has(c.name)
    );
    expect(undecided, JSON.stringify(undecided)).toEqual([]);
  });

  it.each([...SUPPORT_READ_RPCS])(
    'allows %s only because its latest migration is a STABLE, SECURITY INVOKER read',
    (name) => {
      const def = latestDefinition(name);
      expect(
        def,
        `${name} is not defined in supabase/migrations`
      ).not.toBeNull();
      const header = def!.sql.slice(0, def!.sql.indexOf('$$'));
      const body = def!.sql.slice(def!.sql.indexOf('$$'));
      expect(header, def!.file).toMatch(/\bSTABLE\b/i);
      expect(header, def!.file).toMatch(/\bSECURITY\s+INVOKER\b/i);
      expect(header, def!.file).not.toMatch(/\bSECURITY\s+DEFINER\b/i);
      expect(body, def!.file).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i
      );
    }
  );
});
