import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// p11.3 — /api/whatsapp/service-cap.
//
//   R5  GET: any member, exact shape, no Meta, rpc with the session account;
//       managed → numbers: [] without the rpc; no session → 401
//   R6  A never sees B's numbers or counts
//   R7  PATCH: admin only, warn | pause_ai, writes only the session account
//   R8  a failing read → 500 without internals
//
// `fetch` is spied and must never be called: nothing leaves the machine.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDatabase,
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: h.getCurrentAccount,
  requireRole: h.requireRole,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { GET, PATCH } from './route';

const A = 'acct-a';
const B = 'acct-b';

function cfg(id: string, account_id: string, extra: Row = {}): Row {
  return {
    id,
    account_id,
    label: `Label ${id}`,
    display_phone_number: `+1 ${id}`,
    is_default: false,
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

/** What `service_quota_usage` returns, per account — B is exhausted. */
const USAGE: Record<string, Row[]> = {
  [A]: [{ whatsapp_config_id: 'cfg-a2', used: 734, billable: 0 }],
  [B]: [{ whatsapp_config_id: 'cfg-b1', used: 1500, billable: 500 }],
};

let rpcError: { message: string } | null;

function seed(metaBillingA = 'direct') {
  h.db = new FakeDatabase(
    {
      accounts: [
        { id: A, name: 'A', service_cap_action: 'pause_ai' },
        { id: B, name: 'B', service_cap_action: 'warn' },
      ],
      subscriptions: [
        { id: 'sub-a', account_id: A, meta_billing: metaBillingA },
        { id: 'sub-b', account_id: B, meta_billing: 'direct' },
      ],
      whatsapp_config: [
        cfg('cfg-a1', A, { is_default: true }),
        cfg('cfg-a2', A, { created_at: '2026-02-01T00:00:00Z' }),
        cfg('cfg-b1', B, { is_default: true }),
      ],
    },
    {
      service_quota_usage: (args) =>
        rpcError
          ? { data: null, error: rpcError }
          : (USAGE[args.p_account_id as string] ?? []),
    }
  );
}

function ctx(accountId: string, role = 'agent') {
  return {
    accountId,
    userId: `user-${accountId}`,
    role,
    supabase: h.db.asUser({ userId: `user-${accountId}`, accountId }),
  };
}

function patch(body: unknown, raw = false) {
  return PATCH(
    new Request('https://crm.example.com/api/whatsapp/service-cap', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    })
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rpcError = null;
  seed();
  h.getCurrentAccount.mockReset();
  h.requireRole.mockReset();
  h.getCurrentAccount.mockImplementation(async () => ctx(A));
  h.requireRole.mockImplementation(async () => ctx(A, 'admin'));
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rpcCalls = () =>
  h.db.log.filter((e) => e.table === 'rpc:service_quota_usage');

describe('GET /api/whatsapp/service-cap', () => {
  it('an agent gets the exact shape, without Meta, counted for its own account (R5)', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      metaBilling: 'direct',
      action: 'pause_ai',
      freeTier: 1000,
      monthStart: '2026-10-01T00:00:00.000Z',
      resetsAt: '2026-11-01T00:00:00.000Z',
      numbers: [
        {
          id: 'cfg-a1',
          label: 'Label cfg-a1',
          displayPhoneNumber: '+1 cfg-a1',
          used: 0,
          billable: 0,
          exhausted: false,
        },
        {
          id: 'cfg-a2',
          label: 'Label cfg-a2',
          displayPhoneNumber: '+1 cfg-a2',
          used: 734,
          billable: 0,
          exhausted: false,
        },
      ],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rpcCalls()).toHaveLength(1);
    expect(rpcCalls()[0].args).toEqual({
      p_account_id: A,
      p_since: '2026-10-01T00:00:00.000Z',
    });
  });

  it('managed → numbers: [] and the rpc is never called (R5, A6)', async () => {
    seed('managed');
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.metaBilling).toBe('managed');
    expect(body.numbers).toEqual([]);
    expect(rpcCalls()).toHaveLength(0);
  });

  it('no session → 401', async () => {
    h.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
    expect(rpcCalls()).toHaveLength(0);
  });

  it("A never sees B's numbers or B's exhausted count (R6, CP3)", async () => {
    const res = await GET();
    const body = await res.json();
    const ids = body.numbers.map((n: { id: string }) => n.id);
    expect(ids).not.toContain('cfg-b1');
    expect(
      body.numbers.every((n: { exhausted: boolean }) => !n.exhausted)
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain('1500');
    expect(rpcCalls().every((e) => e.args?.p_account_id === A)).toBe(true);
  });

  it('B sees its own number exhausted', async () => {
    h.getCurrentAccount.mockImplementation(async () => ctx(B));
    const body = await (await GET()).json();
    expect(body.action).toBe('warn');
    expect(body.numbers).toEqual([
      expect.objectContaining({
        id: 'cfg-b1',
        used: 1500,
        billable: 500,
        exhausted: true,
      }),
    ]);
  });

  it('the rpc failing → 500 with a generic error, no internals (R8)', async () => {
    rpcError = {
      message: 'permission denied for function service_quota_usage',
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Failed to load the service quota',
    });
    err.mockRestore();
  });
});

describe('PATCH /api/whatsapp/service-cap', () => {
  it('an admin switches to warn: 200 and only A is written (R7)', async () => {
    const res = await patch({ action: 'warn' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'warn' });
    expect(h.requireRole).toHaveBeenCalledWith('admin');
    const a = h.db.rows('accounts').find((r) => r.id === A);
    const b = h.db.rows('accounts').find((r) => r.id === B);
    expect(a?.service_cap_action).toBe('warn');
    expect(b?.service_cap_action).toBe('warn'); // untouched (seeded warn)
    const updates = h.db.log.filter(
      (e) => e.table === 'accounts' && e.op === 'update'
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toEqual([{ column: 'id', op: 'eq', value: A }]);
  });

  it('switching to pause_ai never writes B (fuga)', async () => {
    h.db.rows('accounts').find((r) => r.id === A)!.service_cap_action = 'warn';
    const res = await patch({ action: 'pause_ai' });
    expect(res.status).toBe(200);
    expect(
      h.db.rows('accounts').find((r) => r.id === B)?.service_cap_action
    ).toBe('warn');
    const updates = h.db.log.filter(
      (e) => e.table === 'accounts' && e.op === 'update'
    );
    expect(JSON.stringify(updates)).not.toContain(B);
  });

  it.each([
    ['an unknown value', { action: 'foo' }],
    ['a missing action', {}],
    ['a non-string action', { action: 1 }],
  ])('400 for %s, nothing written', async (_label, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(
      h.db.log.filter((e) => e.table === 'accounts' && e.op === 'update')
    ).toHaveLength(0);
  });

  it('400 for invalid JSON', async () => {
    const res = await patch('{not json', true);
    expect(res.status).toBe(400);
  });

  it('below admin → 403, nothing written', async () => {
    h.requireRole.mockRejectedValue(
      new ForbiddenError("This action requires the 'admin' role or higher")
    );
    const res = await patch({ action: 'warn' });
    expect(res.status).toBe(403);
    expect(
      h.db.log.filter((e) => e.table === 'accounts' && e.op === 'update')
    ).toHaveLength(0);
  });

  it('no session → 401', async () => {
    h.requireRole.mockRejectedValue(new UnauthorizedError());
    const res = await patch({ action: 'warn' });
    expect(res.status).toBe(401);
  });
});
