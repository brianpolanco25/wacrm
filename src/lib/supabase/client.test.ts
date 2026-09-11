import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// The browser client is read-only during a support session.
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
    rpc(name: string) {
      h.reached.push(`rpc:${name}`);
      return Promise.resolve({ data: null, error: null });
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
const {
  createClient,
  endSupportSession,
  supportSessionAccountId,
  supportSessionActive,
} = await import('./client');

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

  it('refuses a delete — the exact call contacts/page.tsx makes', async () => {
    const supabase = createClient();

    const { error } = await supabase
      .from('contacts')
      .delete()
      .in('id', ['c1', 'c2']);

    expect(error).toMatchObject({ code: 'support_session_read_only' });
    // And nothing about it reached the network layer.
    expect(h.reached.filter((c) => c.includes('delete'))).toEqual([]);
  });

  it.each(['insert', 'update', 'upsert', 'delete'])(
    'refuses %s, and keeps the chain refusing',
    async (op) => {
      const supabase = createClient();
      const builder = supabase.from('tags') as unknown as Record<
        string,
        (...a: unknown[]) => { select: () => PromiseLike<{ error: unknown }> }
      >;

      const { error } = await builder[op]({ name: 'x' }).select();
      expect(error).toMatchObject({ code: 'support_session_read_only' });
      expect(h.reached).toEqual([]);
    }
  );

  it('refuses rpc wholesale', async () => {
    // Nearly every function in this schema is SECURITY DEFINER; a
    // "read-only" one would still answer for the operator's own account,
    // which is the mislabelled view all over again.
    const supabase = createClient();
    const { error } = await (supabase.rpc(
      'filter_contacts_by_tags',
      {}
    ) as unknown as PromiseLike<{
      error: unknown;
    }>);
    expect(error).toMatchObject({ code: 'support_session_read_only' });
    expect(h.reached).toEqual([]);
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
    'refuses storage.%s — the banner says nothing is saved',
    async (op) => {
      const supabase = createClient();
      const bucket = supabase.storage.from('avatars') as unknown as Record<
        string,
        (...a: unknown[]) => PromiseLike<{ error: unknown }>
      >;

      const { error } = await bucket[op]('some/path', new Blob());
      expect(error).toMatchObject({ code: 'support_session_read_only' });
      expect(h.reached).toEqual([]);
    }
  );

  it('refuses the avatar upload profile-form.tsx makes, before it can orphan an object', async () => {
    const supabase = createClient();
    const { error } = await supabase.storage
      .from('avatars')
      .upload('operator-1/avatar.png', new Blob(), { upsert: true });

    expect(error).toMatchObject({ code: 'support_session_read_only' });
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

    expect(error).toMatchObject({ code: 'support_session_read_only' });
    expect(h.reached).toEqual([]);
  });
});

describe('the browser client with no support session', () => {
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
