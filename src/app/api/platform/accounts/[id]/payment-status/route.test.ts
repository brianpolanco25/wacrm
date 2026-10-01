import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// p11.1 — POST /api/platform/accounts/[id]/payment-status: «Comprobar de
// nuevo» from the operator's file (R21). Platform operators only, scoped
// to the account in the URL, also for `managed` accounts.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDatabase,
  requirePlatformAdmin: vi.fn(),
}));

vi.mock('@/lib/auth/platform', () => ({
  requirePlatformAdmin: h.requirePlatformAdmin,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => String(v).replace(/^enc:/, ''),
}));

import { ForbiddenError } from '@/lib/auth/account';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

function cfg(id: string, account_id: string): Row {
  return {
    id,
    account_id,
    phone_number_id: `pn-${id}`,
    waba_id: `waba-${id}`,
    access_token: `enc:token-${id}`,
    status: 'connected',
    meta_payment_status: null,
    meta_payment_checked_at: null,
    meta_payment_error: null,
  };
}

function post(accountId: string, body: unknown) {
  return POST(
    new Request(
      `https://crm.example.com/api/platform/accounts/${accountId}/payment-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    ),
    { params: Promise.resolve({ id: accountId }) }
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.db = new FakeDatabase({
    whatsapp_config: [cfg('cfg-a', A), cfg('cfg-b', B)],
  });
  h.requirePlatformAdmin.mockReset();
  h.requirePlatformAdmin.mockResolvedValue({ userId: 'op-1' });
  fetchMock = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'waba-cfg-a' }),
      }) as unknown as Response
  );
  vi.stubGlobal('fetch', fetchMock);
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/platform/accounts/[id]/payment-status', () => {
  it('403 for anyone who is not a platform operator', async () => {
    h.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform administrator access required')
    );
    const res = await post(A, { config_id: 'cfg-a' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks and stores the number of the account in the URL', async () => {
    const res = await post(A, { config_id: 'cfg-a' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('missing');
    expect(json.error).toBeNull();
    const row = h.db.rows('whatsapp_config').find((r) => r.id === 'cfg-a');
    expect(row?.meta_payment_status).toBe('missing');
    const update = h.db.log.find((q) => q.op === 'update');
    expect(update?.filters).toEqual(
      expect.arrayContaining([
        { column: 'id', op: 'eq', value: 'cfg-a' },
        { column: 'account_id', op: 'eq', value: A },
      ])
    );
  });

  it("404 for B's number under A's URL: no fetch, no write", async () => {
    const res = await post(A, { config_id: 'cfg-b' });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.log.some((q) => q.op === 'update')).toBe(false);
  });

  it('404 for an id that is not a UUID, 400 without config_id', async () => {
    expect((await post('nope', { config_id: 'cfg-a' })).status).toBe(404);
    expect((await post(A, {})).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409 with the switch on', async () => {
    vi.stubEnv('META_PAYMENT_CHECK_DISABLED', '1');
    const res = await post(A, { config_id: 'cfg-a' });
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
