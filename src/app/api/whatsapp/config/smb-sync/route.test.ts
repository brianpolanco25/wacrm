import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// #1650 R13–R14 — POST /api/whatsapp/config/smb-sync («Reintentar
// sincronización»).
//
//   R13 admin, own number, inside 24 h → only the types without request_id
//   R14 another account's number → 404, no Meta call, no write;
//       not coexistence → 409; outside 24 h → 409 without Meta;
//       401/403; 429 past 3/min
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
const HOUR = 60 * 60 * 1000;

function cfg(id: string, account_id: string, extra: Row = {}): Row {
  return {
    id,
    account_id,
    phone_number_id: `pn-${id}`,
    waba_id: `waba-${id}`,
    access_token: `enc:token-${id}`,
    status: 'connected',
    coexistence_onboarded_at: new Date(Date.now() - HOUR).toISOString(),
    smb_state_sync_requested_at: null,
    smb_state_sync_request_id: null,
    smb_history_sync_requested_at: null,
    smb_history_sync_request_id: null,
    smb_sync_error: null,
    ...extra,
  };
}

function post(body: unknown) {
  return POST(
    new Request('https://crm.example.com/api/whatsapp/config/smb-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

function row(id: string) {
  return h.db.rows('whatsapp_config').find((r) => r.id === id);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.db = new FakeDatabase({
    whatsapp_config: [
      // A: contacts already synced, history failed at signup.
      cfg('cfg-a', A, {
        smb_state_sync_requested_at: new Date(Date.now() - HOUR).toISOString(),
        smb_state_sync_request_id: 'req-state-old',
        smb_sync_error: 'history: boom',
      }),
      cfg('cfg-b', B),
      cfg('cfg-plain', A, { coexistence_onboarded_at: null }),
      cfg('cfg-old', A, {
        coexistence_onboarded_at: new Date(
          Date.now() - 25 * HOUR
        ).toISOString(),
      }),
    ],
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
        json: async () => ({ request_id: 'req-history-new' }),
      }) as unknown as Response
  );
  vi.stubGlobal('fetch', fetchMock);
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/whatsapp/config/smb-sync', () => {
  it('asks for the admin role', async () => {
    await post({ config_id: 'cfg-a' });
    expect(h.requireRole).toHaveBeenCalledWith('admin');
  });

  it('R13: runs only the pending type with the row token, and returns smb_sync', async () => {
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      smb_sync: { state_sync: 'already_done', history: 'requested' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/pn-cfg-a/smb_app_data');
    expect(JSON.parse(init.body as string).sync_type).toBe('history');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-cfg-a'
    );
    const a = row('cfg-a');
    expect(a?.smb_state_sync_request_id).toBe('req-state-old');
    expect(a?.smb_history_sync_request_id).toBe('req-history-new');
    expect(a?.smb_sync_error).toBeNull();
    // Every write scoped to A.
    for (const q of h.db.log.filter((q) => q.op === 'update')) {
      expect(q.filters).toContainEqual({
        column: 'account_id',
        op: 'eq',
        value: A,
      });
    }
  });

  it("R14: 404 for B's number from A's session — no Meta call, no write (leak A↔B)", async () => {
    const before = JSON.stringify(row('cfg-b'));
    const res = await post({ config_id: 'cfg-b' });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.log.some((q) => q.op === 'update')).toBe(false);
    expect(JSON.stringify(row('cfg-b'))).toBe(before);
    const read = h.db.log.find((q) => q.table === 'whatsapp_config');
    expect(read?.filters).toContainEqual({
      column: 'account_id',
      op: 'eq',
      value: A,
    });
  });

  it('R14: 409 not_coexistence for an ordinary number', async () => {
    const res = await post({ config_id: 'cfg-plain' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_coexistence');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('R14: 409 smb_sync_window_expired past 24 h, without calling Meta', async () => {
    const res = await post({ config_id: 'cfg-old' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('smb_sync_window_expired');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.log.some((q) => q.op === 'update')).toBe(false);
  });

  it('400 without config_id', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('401 without a session', async () => {
    h.requireRole.mockRejectedValue(new UnauthorizedError());
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('403 below admin (agent)', async () => {
    h.requireRole.mockRejectedValue(new ForbiddenError('Insufficient role'));
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('429 past 3 per minute for the same user', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post({ config_id: 'cfg-plain' })).status).toBe(409);
    }
    const res = await post({ config_id: 'cfg-plain' });
    expect(res.status).toBe(429);
  });

  it('a Meta failure still answers 200 with failed, and never logs the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: '(#100) Not allowed', code: 100 },
      }),
    } as unknown as Response);
    const res = await post({ config_id: 'cfg-a' });
    expect(res.status).toBe(200);
    expect((await res.json()).smb_sync.history).toBe('failed');
    expect(row('cfg-a')?.smb_history_sync_requested_at).toBeNull();
    expect(row('cfg-a')?.smb_sync_error).toBe('history: (#100) Not allowed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('token-cfg-a');
  });
});
