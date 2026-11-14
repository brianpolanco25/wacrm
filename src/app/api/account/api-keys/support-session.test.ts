import { beforeEach, describe, expect, it, vi } from 'vitest';

// API keys inside a support session (human decision, 2026-11-14): the
// operator mints and revokes the customer's key; it is audited, the key is
// attributed to support, and no other tenant is touched.

const h = vi.hoisted(() => ({
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  ctx: null as unknown as Record<string, unknown>,
  supportHeaders: {} as Record<string, string>,
  failTrail: false,
}));

vi.mock('next/headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/headers')>()),
  headers: async () => new Headers(h.supportHeaders),
}));
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: async () => h.ctx,
    getCurrentAccount: async () => h.ctx,
  };
});
vi.mock('@/lib/auth/support-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/support-actions')>()),
  markSupportActionStatus: async () => {},
}));
vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => {
    const client = h.db.admin;
    if (!h.failTrail) return client;
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) =>
          table === 'impersonation_actions'
            ? {
                insert: async () => ({ error: { message: 'down' } }),
                update: () => ({
                  eq: () => ({
                    eq: () => ({
                      eq: () => ({
                        select: async () => ({ error: { message: 'down' } }),
                      }),
                    }),
                  }),
                }),
              }
            : target.from(table);
      },
    });
  },
}));
vi.mock('@/lib/billing/enforce', () => ({ assertPlanFeature: async () => {} }));

const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { accountCtx, ACCOUNT_A, ACCOUNT_B, OPERATOR, USER_A, SUPPORT_LOG_ID } =
  await import('@/lib/integrations/integrations.test-support');
const { __resetRateLimitForTests } = await import('@/lib/rate-limit');
const { GET, POST } = await import('./route');
const { DELETE } = await import('./[id]/route');
const { supportWriteVerdict } = await import('@/lib/auth/support-scope');

const REQUEST_ID = '7e000000-0000-4000-8000-0000000000aa';
const trail = () => h.db.rows('impersonation_actions');
const keysOf = (account: string) =>
  h.db.rows('api_keys').filter((r) => r.account_id === account);

function tag(method: string, path: string) {
  h.supportHeaders = {
    'x-wacrm-support-method': method,
    'x-wacrm-support-path': path,
    'x-wacrm-support-request': REQUEST_ID,
  };
  trail().push({
    id: 'act-1',
    log_id: SUPPORT_LOG_ID,
    actor_user_id: OPERATOR,
    account_id: ACCOUNT_A,
    method,
    path,
    status: null,
    source: 'http',
    request_id: REQUEST_ID,
  });
}

const create = (body: unknown) =>
  POST(
    new Request('http://localhost/api/account/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
const revoke = (id: string) =>
  DELETE(new Request('http://localhost', { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  __resetRateLimitForTests();
  h.db = new FakeDatabase({
    api_keys: [
      {
        id: 'key-b',
        account_id: ACCOUNT_B,
        name: 'B key',
        key_prefix: 'wacrm_live_bbbb',
        key_hash: 'hash-b',
        scopes: [],
        revoked_at: null,
        created_by: USER_A,
        created_at: '2026-11-01T00:00:00.000Z',
      },
    ],
    platform_admins: [{ user_id: OPERATOR }],
    impersonation_actions: [],
  });
  h.ctx = accountCtx('admin', { impersonated: true });
  h.supportHeaders = {};
  h.failTrail = false;
});

describe('support session — API keys', () => {
  it('mints the key on the impersonated account and leaves a trail without the key', async () => {
    const path = '/api/account/api-keys';
    tag('POST', path);

    const res = await create({ name: 'Cabbity Health', scopes: [] });
    expect(res.status).toBe(201);
    const body = await res.json();

    const [row] = keysOf(ACCOUNT_A);
    expect(row).toMatchObject({
      account_id: ACCOUNT_A,
      created_by: USER_A,
      name: 'Cabbity Health',
    });
    expect(row.key_hash).not.toBe(body.plaintext);

    expect(trail()).toHaveLength(1);
    const [entry] = trail();
    expect(entry).toMatchObject({
      account_id: ACCOUNT_A,
      log_id: SUPPORT_LOG_ID,
      actor_user_id: OPERATOR,
      method: 'POST',
    });
    expect(String(entry.path).split(' · ')[1]).toBe('api_key.create');
    expect(JSON.stringify(trail())).not.toContain(body.plaintext);
    // The other company is untouched.
    expect(keysOf(ACCOUNT_B)).toHaveLength(1);
  });

  it('writes nothing when the trail cannot be saved (503)', async () => {
    tag('POST', '/api/account/api-keys');
    h.failTrail = true;
    const res = await create({ name: 'Cabbity Health' });
    expect(res.status).toBe(503);
    expect(h.db.rows('api_keys')).toHaveLength(1);
  });

  it('revokes only the impersonated account key and records it', async () => {
    h.db.rows('api_keys').push({
      id: 'key-a',
      account_id: ACCOUNT_A,
      name: 'A key',
      revoked_at: null,
    });
    tag('DELETE', '/api/account/api-keys/key-a');

    const res = await revoke('key-a');
    expect(res.status).toBe(200);
    expect(keysOf(ACCOUNT_A)[0].revoked_at).not.toBeNull();
    expect(String(trail()[0].path).split(' · ')[1]).toBe('api_key.revoke');

    // Another tenant's key is a 404 and stays live.
    const other = await revoke('key-b');
    expect(other.status).toBe(404);
    expect(keysOf(ACCOUNT_B)[0].revoked_at).toBeNull();
  });

  it('lists the account keys, flagging the ones support minted', async () => {
    h.db.rows('api_keys').push(
      {
        id: 'key-s',
        account_id: ACCOUNT_A,
        name: 'Minted by support',
        created_by: OPERATOR,
        created_at: '2026-11-14T00:00:00.000Z',
      },
      {
        id: 'key-c',
        account_id: ACCOUNT_A,
        name: 'Minted by the customer',
        created_by: USER_A,
        created_at: '2026-11-13T00:00:00.000Z',
      }
    );
    const res = await GET();
    const { keys } = await res.json();
    expect(
      keys.map((k: Record<string, unknown>) => [k.id, k.created_by_support])
    ).toEqual([
      ['key-s', true],
      ['key-c', false],
    ]);
    // No ids of people, no cross-tenant rows.
    expect(JSON.stringify(keys)).not.toContain('created_by"');
    expect(keys.some((k: Record<string, unknown>) => k.id === 'key-b')).toBe(
      false
    );
  });
});

describe('what a support session still cannot do', () => {
  it.each([
    ['POST', '/api/billing/checkout'],
    ['POST', '/api/account/transfer-ownership'],
    ['PATCH', '/api/account/members/u-1'],
    ['POST', '/api/account/invitations'],
    ['POST', '/api/account/webhooks'],
  ])('blocks %s %s', (method, path) => {
    expect(supportWriteVerdict(method, path)).toBe('block');
  });

  it.each([
    ['POST', '/api/account/api-keys'],
    ['DELETE', '/api/account/api-keys/k-1'],
    ['POST', '/api/account/api-keys/k-1/rotate'],
  ])('records %s %s', (method, path) => {
    expect(supportWriteVerdict(method, path)).toBe('record');
  });
});
