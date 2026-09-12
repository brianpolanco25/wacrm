import { beforeEach, describe, expect, it, vi } from 'vitest';

// The guard on `/api/platform/*`. The criterion it exists for: "las rutas
// de plataforma son inaccesibles para cualquier usuario que no esté en
// platform_admins" — including, and especially, a company `owner`.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  userErr: null as unknown,
  /** Rows in `platform_admins`, keyed by user_id. */
  admins: new Map<string, Record<string, unknown>>(),
  /** Every query the service-role client ran, for the scope assertion. */
  queries: [] as { table: string; eq: [string, unknown][] }[],
  lookupError: null as unknown,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: h.user },
        error: h.userErr,
      }),
    },
  }),
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call = { table, eq: [] as [string, unknown][] };
      h.queries.push(call);
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          call.eq.push([column, value]);
          return builder;
        },
        maybeSingle: async () => {
          if (h.lookupError) return { data: null, error: h.lookupError };
          const [, userId] = call.eq.find(([c]) => c === 'user_id') ?? [];
          return { data: h.admins.get(userId as string) ?? null, error: null };
        },
      };
      return builder;
    },
  }),
}));

const { requirePlatformAdmin } = await import('./platform');
const { UnauthorizedError, ForbiddenError } = await import('./account');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  h.user = null;
  h.userErr = null;
  h.admins.clear();
  h.queries = [];
  h.lookupError = null;
});

describe('requirePlatformAdmin', () => {
  it('rejects an anonymous caller with 401', async () => {
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  it('rejects an authenticated user with no platform_admins row with 403', async () => {
    h.user = { id: OWNER };
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects a company owner — owning a company is not operating the platform', async () => {
    // The spec forbids reusing `owner` for this "bajo ningún concepto".
    // This guard never reads `account_role` at all, which is the point:
    // there is no role value that can be mistaken for platform access.
    h.user = { id: OWNER };
    h.admins.set(OPERATOR, { user_id: OPERATOR, granted_at: null, note: null });

    await expect(requirePlatformAdmin()).rejects.toMatchObject({ status: 403 });
    // Nothing about roles was consulted; only platform_admins.
    expect(h.queries.map((q) => q.table)).toEqual(['platform_admins']);
  });

  it('resolves for a user who does have the row', async () => {
    h.user = { id: OPERATOR };
    h.admins.set(OPERATOR, {
      user_id: OPERATOR,
      granted_at: '2026-01-01T00:00:00.000Z',
      note: 'bootstrap',
    });

    const ctx = await requirePlatformAdmin();
    expect(ctx.userId).toBe(OPERATOR);
    expect(ctx.admin).toEqual({
      userId: OPERATOR,
      grantedAt: '2026-01-01T00:00:00.000Z',
      note: 'bootstrap',
    });
  });

  it('looks the caller up by their own authenticated id, never by anything else', async () => {
    h.user = { id: OPERATOR };
    h.admins.set(OPERATOR, { user_id: OPERATOR });
    await requirePlatformAdmin();
    expect(h.queries).toEqual([
      { table: 'platform_admins', eq: [['user_id', OPERATOR]] },
    ]);
  });

  it('fails closed when the lookup errors', async () => {
    // A database that cannot answer must not be a way in.
    h.user = { id: OPERATOR };
    h.admins.set(OPERATOR, { user_id: OPERATOR });
    h.lookupError = { message: 'connection reset' };

    await expect(requirePlatformAdmin()).rejects.toMatchObject({ status: 403 });
  });
});
