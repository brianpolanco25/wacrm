import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount resolves the caller's account context. The
// regression this file guards (issue #294): account loading must NOT
// depend on a PostgREST embedded FK join (`accounts!inner`), because a
// stale schema cache makes that embed fail hard and blanks the whole
// context. It must instead read the profile and then the account with
// two plain point queries.

// ------------------------------------------------------------
// Chainable Supabase query-builder mock. Each `.from(table)` hands back
// a thenable builder pre-loaded with the result queued for that table,
// so we can assert which tables were queried and with what filters.
// ------------------------------------------------------------
interface BuilderCall {
  table: string;
  columns?: string;
  eqArgs: [string, unknown][];
}

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  byTable: Record<string, { data: unknown; error: unknown }>;
}) {
  const calls: BuilderCall[] = [];

  const from = (table: string) => {
    const call: BuilderCall = { table, eqArgs: [] };
    calls.push(call);
    const builder = {
      select(columns: string) {
        call.columns = columns;
        return builder;
      },
      eq(col: string, val: unknown) {
        call.eqArgs.push([col, val]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(
          opts.byTable[table] ?? { data: null, error: null },
        );
      },
    };
    return builder;
  };

  return {
    calls,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: opts.user },
            error: opts.userErr ?? null,
          }),
      },
      from,
    },
  };
}

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
}));

// Fase 3 §5: `requireRole` now also asks the billing layer whether the
// account may write at all. Only that entry point is stubbed —
// `importOriginal` keeps `AccountLockedError` and `billingErrorPayload`
// real so `toErrorResponse` maps the genuine article.
const billing = vi.hoisted(() => ({
  assertWritable: vi.fn(async () => ({}) as never),
}));
vi.mock("@/lib/billing/enforce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/enforce")>()),
  assertWritable: billing.assertWritable,
}));

const { AccountLockedError } = await import("@/lib/billing/enforce");

const {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
  ForbiddenError,
} = await import("./account");

/** A client whose profile row carries `role`, with a readable account. */
function memberClient(role: string) {
  return makeClient({
    user: { id: "user-1" },
    byTable: {
      profiles: {
        data: { account_id: "acct-1", account_role: role },
        error: null,
      },
      accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
    },
  }).client;
}

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  billing.assertWritable.mockReset();
  billing.assertWritable.mockResolvedValue({} as never);
});

describe("getCurrentAccount", () => {
  it("resolves context via a plain accounts lookup, not an embedded join", async () => {
    const { client, calls } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "owner" },
          error: null,
        },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { id: "acct-1", name: "Acme" },
    });

    // Two queries: profiles by user_id, then accounts by id. Neither
    // selects an embedded relationship — the regression guard.
    expect(calls.map((c) => c.table)).toEqual(["profiles", "accounts"]);
    expect(calls[0].columns).not.toMatch(/accounts!/);
    expect(calls[0].eqArgs).toEqual([["user_id", "user-1"]]);
    expect(calls[1].columns).not.toMatch(/accounts!/);
    expect(calls[1].eqArgs).toEqual([["id", "acct-1"]]);
  });

  it("throws UnauthorizedError when there is no session", async () => {
    const { client } = makeClient({ user: null, byTable: {} });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps a profiles query error to 'Could not load account context'", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Could not load account context",
    );
  });

  it("maps an accounts query error to 'Could not load account context'", async () => {
    // The exact #294 shape if the embed were still in play, but now on
    // the decoupled accounts lookup: profile resolves, account read errors.
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "admin" },
          error: null,
        },
        accounts: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Could not load account context");
  });

  it("rejects a profile not linked to an account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: { account_id: null, account_role: null }, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });

  it("rejects an account_id that resolves to no readable account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "viewer" },
          error: null,
        },
        accounts: { data: null, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });
});

// ---------------------------------------------------------------------------
// Fase 3 §5 — the dunning ladder lives in the permission layer.
//
// A read-only account behaves as if every member were a `viewer`. The
// real roles in `profiles.account_role` are never touched, so settling
// the subscription restores them with no repair step.
// ---------------------------------------------------------------------------
describe('requireRole — billing read-only gate (fase 3 §5)', () => {
  it('does not consult billing for a read (min = viewer)', async () => {
    createClient.mockReturnValue(memberClient('viewer'));
    const ctx = await requireRole('viewer');
    expect(ctx.role).toBe('viewer');
    // Reads keep working while the account is locked, and every list
    // endpoint in the app is spared the entitlements round trip.
    expect(billing.assertWritable).not.toHaveBeenCalled();
  });

  it("checks the caller's own account before allowing a write", async () => {
    createClient.mockReturnValue(memberClient('agent'));
    await requireRole('agent');
    expect(billing.assertWritable).toHaveBeenCalledWith('acct-1');
  });

  it('refuses an OWNER of a locked account — everyone drops to viewer', async () => {
    createClient.mockReturnValue(memberClient('owner'));
    billing.assertWritable.mockRejectedValue(
      new AccountLockedError('suspended')
    );
    await expect(requireRole('admin')).rejects.toBeInstanceOf(
      AccountLockedError
    );
  });

  it('refuses an OWNER of an account the PLATFORM suspended by hand (fase 4 §2)', async () => {
    // The manual hold of migration 058 reaches the permission layer
    // through the same gate as the dunning ladder, and that is the whole
    // point of putting it inside `getEntitlements`: f3.4 honours it
    // without a line of its own.
    createClient.mockReturnValue(memberClient("owner"));
    billing.assertWritable.mockRejectedValue(
      new AccountLockedError("active", true)
    );
    await expect(requireRole("agent")).rejects.toMatchObject({
      status: 403,
      manualHold: true,
    });
  });

  it('lets a manually suspended account keep READING — it is a hold, not a ban', async () => {
    createClient.mockReturnValue(memberClient("owner"));
    billing.assertWritable.mockRejectedValue(
      new AccountLockedError("active", true)
    );
    const ctx = await requireRole("viewer");
    expect(ctx.accountId).toBe("acct-1");
    expect(billing.assertWritable).not.toHaveBeenCalled();
  });

  it('still reports an insufficient role as a role problem, before billing', async () => {
    createClient.mockReturnValue(memberClient('viewer'));
    billing.assertWritable.mockRejectedValue(
      new AccountLockedError('suspended')
    );
    await expect(requireRole('admin')).rejects.toBeInstanceOf(ForbiddenError);
    expect(billing.assertWritable).not.toHaveBeenCalled();
  });

  it('honours allowReadOnly so a locked account can still reach its checkout', async () => {
    createClient.mockReturnValue(memberClient('admin'));
    billing.assertWritable.mockRejectedValue(
      new AccountLockedError('suspended')
    );
    const ctx = await requireRole('admin', { allowReadOnly: true });
    expect(ctx.accountId).toBe('acct-1');
    expect(billing.assertWritable).not.toHaveBeenCalled();
  });

  it("does not rewrite the member's real role", async () => {
    createClient.mockReturnValue(memberClient('owner'));
    billing.assertWritable.mockRejectedValue(new AccountLockedError('expired'));
    await requireRole('agent').catch(() => {});
    // The downgrade is a refusal, not a write: nothing was UPDATEd.
    const ctx = await requireRole('viewer');
    expect(ctx.role).toBe('owner');
  });
});

describe('toErrorResponse — billing errors (fase 3 §4/§5)', () => {
  it('maps the read-only lock to 403 with a machine code and the way out', async () => {
    const res = toErrorResponse(new AccountLockedError('suspended'));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('account_read_only');
    expect(json.subscriptionStatus).toBe('suspended');
    expect(json.upgradeUrl).toBe('/billing');
  });

  it('still collapses an unknown error to a generic 500', async () => {
    const res = toErrorResponse(new Error('internals'));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Internal server error');
    expect(json.error).not.toMatch(/internals/);
  });
});

describe("toErrorResponse — body-reading errors (a7.8 §1)", () => {
  it("maps an ApiError from readJsonBody to its status in the { error } envelope", async () => {
    const { payloadTooLarge } = await import("@/lib/api/v1/respond");
    const res = toErrorResponse(payloadTooLarge("too big"));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too big" });
  });
});
