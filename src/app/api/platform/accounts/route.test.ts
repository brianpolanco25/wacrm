import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/platform/accounts — the census, and the guard that is the
// acceptance criterion of §2: «un administrador de plataforma ve todas
// las cuentas; un `owner` normal no ve más que la suya». The `owner`
// half is tested here as "sees none of this route at all", which is the
// stronger statement.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  listCalls: [] as unknown[],
  listResult: {
    accounts: [] as unknown[],
    total: 0,
    limit: 50,
    offset: 0,
  } as Record<string, unknown>,
  listError: null as unknown,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: (_c: string, userId: string) => ({
          maybeSingle: async () => ({
            data: h.admins.has(userId)
              ? { user_id: userId, granted_at: null, note: null }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/platform/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/accounts')>()),
  listAccounts: async (params: unknown) => {
    h.listCalls.push(params);
    if (h.listError) throw h.listError;
    return h.listResult;
  },
}));

const { GET } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';

function req(query = '') {
  return new Request(`http://localhost/api/platform/accounts${query}`);
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.listCalls = [];
  h.listError = null;
  h.listResult = { accounts: [], total: 0, limit: 50, offset: 0 };
});

describe('the guard', () => {
  it('401s a visitor with no session', async () => {
    h.user = null;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(h.listCalls).toEqual([]);
  });

  it('403s a company owner — owning a company is not operating the platform', async () => {
    h.user = { id: PLAIN_OWNER };
    const res = await GET(req());
    expect(res.status).toBe(403);
    // And the census was never even asked for.
    expect(h.listCalls).toEqual([]);
  });

  it('leaks nothing about the service in the refusal', async () => {
    h.user = { id: PLAIN_OWNER };
    const body = await (await GET(req())).json();
    expect(JSON.stringify(body)).not.toMatch(/account|plan|company/i);
  });

  it('lets a platform admin see every account', async () => {
    h.listResult = {
      accounts: [
        { accountId: 'a', name: 'Company A' },
        { accountId: 'b', name: 'Company B' },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    };
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.accounts).toHaveLength(2);
  });
});

describe('paging and search', () => {
  it('passes the search term straight through', async () => {
    await GET(req('?q=Company%20A'));
    expect(h.listCalls[0]).toMatchObject({ search: 'Company A' });
  });

  it('clamps the page size and the offset before they reach the database', async () => {
    await GET(req('?limit=100000&offset=-3'));
    expect(h.listCalls[0]).toMatchObject({ limit: 200, offset: 0 });
  });

  it('falls back to the defaults for junk parameters', async () => {
    await GET(req('?limit=abc&offset=xyz'));
    expect(h.listCalls[0]).toMatchObject({ limit: 50, offset: 0 });
  });
});

describe('failures', () => {
  it('500s without echoing the database error', async () => {
    h.listError = new Error('relation "accounts" does not exist');
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('relation');
  });
});
