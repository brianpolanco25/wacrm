import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// p11.1 — POST /api/whatsapp/config/payment-status («Comprobar de nuevo»).
//
//   R11 admin only, 6/min per user, 200 with what was stored
//   R12 a config_id of another account → 404, no fetch, no UPDATE
//   R13 META_PAYMENT_CHECK_DISABLED=1 → 409, no fetch
//
// Meta is `fetch`, mocked: nothing leaves the machine.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDatabase,
  requireRole: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: h.requireRole,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => {
    if (!String(v).startsWith('enc:')) throw new Error('bad ciphertext');
    return String(v).replace(/^enc:/, '');
  },
}));

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const A = 'acct-a';
const B = 'acct-b';

function cfg(id: string, account_id: string, extra: Row = {}): Row {
  return {
    id,
    account_id,
    phone_number_id: `pn-${id}`,
    waba_id: `waba-${id}`,
    access_token: `enc:token-${id}`,
    status: 'connected',
    meta_payment_status: 'missing',
    meta_payment_checked_at: '2026-10-01T00:00:00.000Z',
    meta_payment_error: null,
    ...extra,
  };
}

function post(body: unknown) {
  return POST(
    new Request('https://crm.example.com/api/whatsapp/config/payment-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.db = new FakeDatabase({
    whatsapp_config: [cfg('cfg-a', A), cfg('cfg-b', B)],
  });
  h.requireRole.mockReset();
  h.requireRole.mockResolvedValue({
    accountId: A,
    userId: 'user-a',
    role: 'admin',
  });
  fetchMock = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'waba-cfg-a', primary_funding_id: 'f-1' }),
      }) as unknown as Response
  );
  vi.stubGlobal('fetch', fetchMock);
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/whatsapp/config/payment-status', () => {
  it('asks for the admin role', async () => {
    await post({ config_id: 'cfg-a' });
    expect(h.requireRole).toHaveBeenCalledWith('admin');
  });

  it('401 without a session', async () => {
    h.requireRole.mockRejectedValue(new UnauthorizedError());
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('403 below admin', async () => {
    h.requireRole.mockRejectedValue(new ForbiddenError('Insufficient role'));
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('200: checks the row with its own token and returns what was stored', async () => {
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(typeof json.checked_at).toBe('string');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/waba-cfg-a?fields=id,primary_funding_id');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-cfg-a'
    );
    const a = h.db.rows('whatsapp_config').find((r) => r.id === 'cfg-a');
    expect(a?.meta_payment_status).toBe('ok');
    expect(a?.meta_payment_checked_at).toBe(json.checked_at);
  });

  it('400 without config_id', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 for B's number from A's session: no fetch, no UPDATE (R12, leak A↔B)", async () => {
    const before = JSON.stringify(
      h.db.rows('whatsapp_config').find((r) => r.id === 'cfg-b')
    );
    const res = await post({ config_id: 'cfg-b' });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.log.some((q) => q.op === 'update')).toBe(false);
    expect(
      JSON.stringify(h.db.rows('whatsapp_config').find((r) => r.id === 'cfg-b'))
    ).toBe(before);
    // The read itself was scoped to A.
    const read = h.db.log.find((q) => q.table === 'whatsapp_config');
    expect(read?.filters).toContainEqual({
      column: 'account_id',
      op: 'eq',
      value: A,
    });
  });

  it('429 past 6 per minute for the same user', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await post({ config_id: 'cfg-a' })).status).toBe(200);
    }
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('409 with META_PAYMENT_CHECK_DISABLED=1, and Meta is not called (R13)', async () => {
    vi.stubEnv('META_PAYMENT_CHECK_DISABLED', '1');
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('payment_check_disabled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.log).toHaveLength(0);
  });

  it("a permission error from Meta is stored as unknown with Meta's message", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: '(#10) No permission', code: 10 },
      }),
    } as unknown as Response);
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('unknown');
    const a = h.db.rows('whatsapp_config').find((r) => r.id === 'cfg-a');
    expect(a?.meta_payment_error).toBe('(#10) No permission');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('token-cfg-a');
    warn.mockRestore();
  });
});
