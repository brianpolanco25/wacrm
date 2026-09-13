import { beforeEach, describe, expect, it, vi } from 'vitest';

// getCurrentAccount / requireRole inside a support session.
//
// The contract the spec asks for, in one place:
//   - the account context resolves to the IMPERSONATED account, and only
//     while the session is valid and the actor really is a platform admin;
//   - the effective role is `viewer`, so every write guard refuses;
//   - the operator's own `profiles.account_id` is never read, let alone
//     written — nothing about the actor's own company moves;
//   - when the session expires, the very next request is back in their
//     own account.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  /** What `resolveSupportSession` should return. */
  support: null as null | {
    logId: string;
    actorUserId: string;
    accountId: string;
    expiresAt: number;
  },
  resolveCalls: [] as string[],
  /** Rows the session client (RLS) would see. */
  profiles: new Map<string, { account_id: string; account_role: string }>(),
  /** Every account row, readable only through the service role. */
  accounts: new Map<string, { id: string; name: string }>(),
  sessionQueries: [] as { table: string; eq: [string, unknown][] }[],
  adminQueries: [] as { table: string; eq: [string, unknown][] }[],
  /** Accounts the fase 3 billing gate was asked about, in order. */
  writableChecks: [] as string[],
}));

function builderFor(
  log: { table: string; eq: [string, unknown][] }[],
  resolve: (call: { table: string; eq: [string, unknown][] }) => unknown
) {
  return (table: string) => {
    const call = { table, eq: [] as [string, unknown][] };
    log.push(call);
    const builder = {
      select: () => builder,
      eq(column: string, value: unknown) {
        call.eq.push([column, value]);
        return builder;
      },
      maybeSingle: async () => ({ data: resolve(call), error: null }),
    };
    return builder;
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user }, error: null }),
    },
    from: builderFor(h.sessionQueries, (call) => {
      if (call.table === 'profiles') {
        const [, userId] = call.eq.find(([c]) => c === 'user_id') ?? [];
        return h.profiles.get(userId as string) ?? null;
      }
      if (call.table === 'accounts') {
        const [, id] = call.eq.find(([c]) => c === 'id') ?? [];
        return h.accounts.get(id as string) ?? null;
      }
      return null;
    }),
  }),
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: builderFor(h.adminQueries, (call) => {
      const [, id] = call.eq.find(([c]) => c === 'id') ?? [];
      return h.accounts.get(id as string) ?? null;
    }),
  }),
}));

// Fase 3 §5 hung a billing gate off `requireRole` for anything above
// `viewer`. It is stubbed here on purpose: this file is about WHOSE
// account the context resolves to, not about the dunning ladder (that is
// `account.test.ts`). The account it gets asked about is recorded, so the
// merge of the two features cannot quietly start billing the wrong
// company.
vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertWritable: async (accountId: string) => {
    h.writableChecks.push(accountId);
  },
}));

vi.mock('./impersonation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./impersonation')>()),
  resolveSupportSession: async (userId: string) => {
    h.resolveCalls.push(userId);
    return h.support && h.support.actorUserId === userId ? h.support : null;
  },
}));

const { getCurrentAccount, requireRole, ForbiddenError } =
  await import('./account');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const TARGET_ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OWN_ACCOUNT = 'cccccccc-0000-4000-8000-000000000003';

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.support = null;
  h.resolveCalls = [];
  h.sessionQueries = [];
  h.adminQueries = [];
  h.writableChecks = [];
  h.profiles = new Map([
    [OPERATOR, { account_id: OWN_ACCOUNT, account_role: 'owner' }],
  ]);
  h.accounts = new Map([
    [OWN_ACCOUNT, { id: OWN_ACCOUNT, name: 'Operator Ltd' }],
    [TARGET_ACCOUNT, { id: TARGET_ACCOUNT, name: 'Customer Co' }],
  ]);
});

function openSession(expiresAt = Date.now() + 60_000) {
  h.support = {
    logId: 'log-1',
    actorUserId: OPERATOR,
    accountId: TARGET_ACCOUNT,
    expiresAt,
  };
}

describe('getCurrentAccount without a support session', () => {
  it("resolves the caller's own account and real role", async () => {
    const ctx = await getCurrentAccount();
    expect(ctx.accountId).toBe(OWN_ACCOUNT);
    expect(ctx.role).toBe('owner');
    expect(ctx.impersonation).toBeNull();
  });

  it('never touches the service role on the ordinary path', async () => {
    await getCurrentAccount();
    expect(h.adminQueries).toEqual([]);
  });
});

describe('getCurrentAccount inside a support session', () => {
  it('resolves the impersonated account, with the impersonated name', async () => {
    openSession();
    const ctx = await getCurrentAccount();
    expect(ctx.accountId).toBe(TARGET_ACCOUNT);
    expect(ctx.account).toEqual({ id: TARGET_ACCOUNT, name: 'Customer Co' });
  });

  it('downgrades the effective role to viewer, whatever the operator really is', async () => {
    // The operator is an `owner` of their own company. Inside a support
    // session that counts for nothing.
    openSession();
    expect((await getCurrentAccount()).role).toBe('viewer');
  });

  it('exposes the session so the UI can say so out loud', async () => {
    openSession();
    const ctx = await getCurrentAccount();
    expect(ctx.impersonation).toMatchObject({
      logId: 'log-1',
      actorUserId: OPERATOR,
      accountId: TARGET_ACCOUNT,
    });
  });

  it("never reads or writes the operator's own profile", async () => {
    // The account swap is derived per request from a signed cookie. If
    // this ever queried (or worse, updated) `profiles`, a crash or a lost
    // cookie would leave a human stranded inside someone else's company.
    openSession();
    await getCurrentAccount();
    expect(h.sessionQueries).toEqual([]);
  });

  it('reads the impersonated account by primary key through the service role', async () => {
    // `accounts.id` IS the account scope (see SELF_SCOPED_TABLES in the
    // tenant-isolation audit), and the id comes from the signed cookie.
    openSession();
    await getCurrentAccount();
    expect(h.adminQueries).toEqual([
      { table: 'accounts', eq: [['id', TARGET_ACCOUNT]] },
    ]);
  });

  it('refuses when the target account no longer exists', async () => {
    openSession();
    h.accounts.delete(TARGET_ACCOUNT);
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('asks about the session for the authenticated user, not one named in a cookie', async () => {
    openSession();
    await getCurrentAccount();
    expect(h.resolveCalls).toEqual([OPERATOR]);
  });
});

describe('requireRole inside a support session', () => {
  it('lets a read-level guard through on the impersonated account', async () => {
    openSession();
    const ctx = await requireRole('viewer');
    expect(ctx.accountId).toBe(TARGET_ACCOUNT);
  });

  it.each(['agent', 'admin', 'owner'] as const)(
    'refuses every write-level guard (%s)',
    async (min) => {
      openSession();
      await expect(requireRole(min)).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('read-only'),
      });
      // And it is refused for being a support session, before the fase 3
      // billing gate is ever consulted: whether the CUSTOMER'S bill is
      // paid has nothing to do with whether an operator may write.
      expect(h.writableChecks).toEqual([]);
    }
  );

  it('goes back to the operator’s own account and role once the session is gone', async () => {
    openSession();
    expect((await getCurrentAccount()).accountId).toBe(TARGET_ACCOUNT);

    // Expiry is decided inside resolveSupportSession; from here it simply
    // stops resolving. The next request is an ordinary one.
    h.support = null;
    const ctx = await requireRole('owner');
    expect(ctx.accountId).toBe(OWN_ACCOUNT);
    expect(ctx.role).toBe('owner');
    expect(ctx.impersonation).toBeNull();
    // Back to an ordinary request, the fase 3 gate runs again — and about
    // the operator's OWN account, never the one they were looking at.
    expect(h.writableChecks).toEqual([OWN_ACCOUNT]);
  });
});
