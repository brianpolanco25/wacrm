import { beforeEach, describe, expect, it, vi } from 'vitest';

// The data layer of s9.4. The routes are tested with this module mocked;
// here is what it actually writes, and in which order.

interface Call {
  table: string;
  op: string;
  filters: [string, string, unknown][];
  payload?: unknown;
  options?: unknown;
}

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  /** Result per `table:op`, or a function of the call. */
  results: {} as Record<string, unknown>,
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as { message?: string; code?: string } | null,
  invite: {
    args: null as unknown,
    result: { data: { user: { id: 'new-user' } }, error: null } as {
      data: unknown;
      error: unknown;
    },
  },
  audit: [] as Record<string, unknown>[],
  auditId: 'log-1' as string | null,
}));

function builder(table: string) {
  const call: Call = { table, op: 'select', filters: [] };
  h.calls.push(call);
  const settle = () =>
    Promise.resolve(
      (h.results[`${table}:${call.op}`] as object) ?? {
        data: null,
        error: null,
      }
    );
  const b: Record<string, unknown> = {
    select: (_c?: string, opts?: unknown) => {
      if (opts) call.options = opts;
      return b;
    },
    insert: (payload: unknown) => {
      call.op = 'insert';
      call.payload = payload;
      return b;
    },
    update: (payload: unknown) => {
      call.op = 'update';
      call.payload = payload;
      return b;
    },
    upsert: (payload: unknown, options: unknown) => {
      call.op = 'upsert';
      call.payload = payload;
      call.options = options;
      return b;
    },
    eq: (c: string, v: unknown) => (call.filters.push([c, 'eq', v]), b),
    in: (c: string, v: unknown) => (call.filters.push([c, 'in', v]), b),
    is: (c: string, v: unknown) => (call.filters.push([c, 'is', v]), b),
    gt: (c: string, v: unknown) => (call.filters.push([c, 'gt', v]), b),
    order: () => b,
    limit: () => settle(),
    single: () => settle(),
    maybeSingle: () => settle(),
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      settle().then(resolve, reject),
  };
  return b;
}

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpc.push({ name, args });
      return { data: null, error: h.rpcError };
    },
    auth: {
      admin: {
        inviteUserByEmail: async (email: string, options: unknown) => {
          h.invite.args = { email, options };
          return h.invite.result;
        },
      },
    },
  }),
}));

vi.mock('./audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audit')>()),
  recordPlatformAction: async (params: Record<string, unknown>) => {
    // Recorded with the calls so the ORDER against the write is visible.
    h.calls.push({
      table: 'AUDIT',
      op: 'insert',
      filters: [],
      payload: params,
    });
    h.audit.push(params);
    return h.auditId;
  },
}));

const p = await import('./provisioning');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const REASON = 'comped: partner agreement 2026';

beforeEach(() => {
  h.calls = [];
  h.results = {};
  h.rpc = [];
  h.rpcError = null;
  h.invite.args = null;
  h.invite.result = { data: { user: { id: 'new-user' } }, error: null };
  h.audit = [];
  h.auditId = 'log-1';
});

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(p.normalizeEmail('  Owner@ACME.test ')).toBe('owner@acme.test');
  });
  it.each([undefined, null, 42, '', 'nope', 'a@b', 'a b@c.d', '@c.d'])(
    'refuses %s',
    (value) => {
      expect(p.normalizeEmail(value)).toBeNull();
    }
  );
});

describe('isLivePayPalSubscription', () => {
  it.each([
    [{ provider_subscription_id: 'I-1', status: 'active' }, true],
    [{ provider_subscription_id: 'I-1', status: 'past_due' }, true],
    [{ provider_subscription_id: 'I-1', status: 'cancelled' }, false],
    [{ provider_subscription_id: 'I-1', status: 'suspended' }, false],
    [{ provider_subscription_id: null, status: 'active' }, false],
    [null, false],
  ])('%j → %s', (sub, live) => {
    expect(p.isLivePayPalSubscription(sub)).toBe(live);
  });
});

describe('manualPlanRow', () => {
  it('is manual and active, clears every gateway field, leaves the hold alone', () => {
    const row = p.manualPlanRow(A, 'negocio');
    expect(row).toEqual({
      account_id: A,
      plan_id: 'negocio',
      provider: 'manual',
      status: 'active',
      provider_subscription_id: null,
      cycle: null,
      trial_ends_at: null,
      grace_until: null,
      cancel_at_period_end: false,
    });
    // A suspension is its own axis (058): giving a plan must not lift it.
    expect(Object.keys(row).some((k) => k.startsWith('manual_hold'))).toBe(
      false
    );
  });
});

describe('overridePlan', () => {
  function params() {
    return {
      accountId: A,
      accountName: 'Company A',
      planId: 'negocio',
      actorUserId: OPERATOR,
      reason: REASON,
    };
  }

  it('records from/to plan and provider, THEN upserts the manual row for that account only', async () => {
    h.results['plans:select'] = { data: { id: 'negocio' }, error: null };
    h.results['subscriptions:select'] = {
      data: {
        plan_id: 'pro',
        provider: 'paypal',
        status: 'cancelled',
        provider_subscription_id: 'I-OLD',
      },
      error: null,
    };

    const out = await p.overridePlan(params());
    expect(out).toEqual({ ok: true, fromPlan: 'pro', fromProvider: 'paypal' });

    expect(h.audit).toEqual([
      {
        action: 'plan_override',
        actorUserId: OPERATOR,
        accountId: A,
        accountName: 'Company A',
        reason: REASON,
        details: {
          from_plan: 'pro',
          to_plan: 'negocio',
          from_provider: 'paypal',
        },
      },
    ]);

    const order = h.calls.map((c) => `${c.table}:${c.op}`);
    expect(order.indexOf('AUDIT:insert')).toBeLessThan(
      order.indexOf('subscriptions:upsert')
    );
    const read = h.calls.find(
      (c) => c.table === 'subscriptions' && c.op === 'select'
    )!;
    expect(read.filters).toEqual([['account_id', 'eq', A]]);
    const write = h.calls.find((c) => c.op === 'upsert')!;
    expect(write.payload).toEqual(p.manualPlanRow(A, 'negocio'));
    expect(write.options).toEqual({ onConflict: 'account_id' });
  });

  it('refuses a subscription PayPal is still billing, and writes nothing', async () => {
    h.results['plans:select'] = { data: { id: 'negocio' }, error: null };
    h.results['subscriptions:select'] = {
      data: {
        plan_id: 'pro',
        provider: 'paypal',
        status: 'active',
        provider_subscription_id: 'I-LIVE',
      },
      error: null,
    };
    expect(await p.overridePlan(params())).toEqual({
      ok: false,
      reason: 'paypal_active',
    });
    expect(h.audit).toEqual([]);
    expect(h.calls.some((c) => c.op === 'upsert')).toBe(false);
  });

  it('refuses a plan that is not in the catalogue', async () => {
    h.results['plans:select'] = { data: null, error: null };
    expect(await p.overridePlan(params())).toEqual({
      ok: false,
      reason: 'unknown_plan',
    });
    expect(h.audit).toEqual([]);
  });

  it('changes nothing when the trail cannot be written', async () => {
    h.results['plans:select'] = { data: { id: 'negocio' }, error: null };
    h.auditId = null;
    expect(await p.overridePlan(params())).toEqual({
      ok: false,
      reason: 'audit_failed',
    });
    expect(h.calls.some((c) => c.op === 'upsert')).toBe(false);
  });

  it('works on a company with no subscription row at all', async () => {
    h.results['plans:select'] = { data: { id: 'negocio' }, error: null };
    const out = await p.overridePlan(params());
    expect(out).toEqual({ ok: true, fromPlan: null, fromProvider: null });
    expect(h.calls.some((c) => c.op === 'upsert')).toBe(true);
  });
});

describe('inviteAuthUser', () => {
  it('asks Supabase to invite, with the name and the redirect', async () => {
    const out = await p.inviteAuthUser({
      email: 'owner@acme.test',
      fullName: 'Ana Owner',
      redirectTo: 'https://app.example/login',
    });
    expect(out).toEqual({ ok: true, userId: 'new-user' });
    expect(h.invite.args).toEqual({
      email: 'owner@acme.test',
      options: {
        data: { full_name: 'Ana Owner' },
        redirectTo: 'https://app.example/login',
      },
    });
  });

  it('says "exists" when Supabase already has that user', async () => {
    h.invite.result = {
      data: { user: null },
      error: {
        code: 'email_exists',
        message: 'A user with this email address has already been registered',
      },
    };
    expect(
      await p.inviteAuthUser({ email: 'x@y.test', redirectTo: 'https://a/b' })
    ).toEqual({ ok: false, reason: 'exists' });
  });

  it('says "failed" for anything else', async () => {
    h.invite.result = {
      data: { user: null },
      error: { message: 'SMTP down' },
    };
    expect(
      await p.inviteAuthUser({ email: 'x@y.test', redirectTo: 'https://a/b' })
    ).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('the scoped writes', () => {
  it('renames by the account id', async () => {
    await p.renameAccount(A, 'Acme');
    expect(h.calls[0]).toMatchObject({
      table: 'accounts',
      op: 'update',
      payload: { name: 'Acme' },
      filters: [['id', 'eq', A]],
    });
  });

  it('counts the seats of ONE company: members plus open invitations', async () => {
    h.results['profiles:select'] = { count: 2, error: null };
    h.results['account_invitations:select'] = { count: 1, error: null };
    expect(await p.countSeats(A)).toBe(3);
    for (const call of h.calls) {
      expect(call.filters[0]).toEqual(['account_id', 'eq', A]);
    }
  });

  it('writes the invitation under the company of the file', async () => {
    h.results['account_invitations:insert'] = {
      data: { id: 'inv-1', expires_at: '2026-10-07T00:00:00.000Z' },
      error: null,
    };
    const out = await p.insertInvitation({
      accountId: A,
      tokenHash: 'hash',
      role: 'agent',
      createdBy: OPERATOR,
      label: 'x@y.test',
      expiresAt: new Date('2026-10-07T00:00:00.000Z'),
    });
    expect(out).toEqual({ id: 'inv-1', expiresAt: '2026-10-07T00:00:00.000Z' });
    expect(h.calls[0].payload).toMatchObject({
      account_id: A,
      token_hash: 'hash',
      role: 'agent',
      created_by_user_id: OPERATOR,
    });
  });
});

describe('operators', () => {
  it('lists platform_admins with their names from profiles', async () => {
    h.results['platform_admins:select'] = {
      data: [
        {
          user_id: 'u1',
          granted_by: 'u1',
          granted_at: '2026-01-01',
          note: 'boot',
        },
        {
          user_id: 'u2',
          granted_by: 'u1',
          granted_at: '2026-02-01',
          note: null,
        },
      ],
      error: null,
    };
    h.results['profiles:select'] = {
      data: [{ user_id: 'u2', full_name: 'Bea', email: 'bea@x.test' }],
      error: null,
    };
    const list = await p.listOperators();
    expect(list).toEqual([
      {
        userId: 'u1',
        email: null,
        fullName: null,
        grantedAt: '2026-01-01',
        grantedBy: 'u1',
        note: 'boot',
      },
      {
        userId: 'u2',
        email: 'bea@x.test',
        fullName: 'Bea',
        grantedAt: '2026-02-01',
        grantedBy: 'u1',
        note: null,
      },
    ]);
    const names = h.calls.find((c) => c.table === 'profiles')!;
    expect(names.filters).toEqual([['user_id', 'in', ['u1', 'u2']]]);
  });

  it('grants and revokes through the 071 functions', async () => {
    expect(
      await p.grantOperator({ userId: 'u2', actorUserId: 'u1', reason: REASON })
    ).toEqual({ ok: true });
    expect(
      await p.revokeOperator({
        userId: 'u2',
        actorUserId: 'u1',
        reason: REASON,
      })
    ).toEqual({ ok: true });
    expect(h.rpc).toEqual([
      {
        name: 'platform_grant_operator',
        args: { p_user: 'u2', p_by: 'u1', p_reason: REASON },
      },
      {
        name: 'platform_revoke_operator',
        args: { p_user: 'u2', p_by: 'u1', p_reason: REASON },
      },
    ]);
  });

  it.each([
    [{ message: 'operator_self' }, 'self'],
    [{ message: 'operator_last' }, 'last'],
    [{ message: 'operator_absent' }, 'absent'],
    [{ message: 'operator_exists' }, 'exists'],
    [{ message: 'user_absent' }, 'user_absent'],
    [{ message: 'new row violates check', code: '23514' }, 'bad_reason'],
    [{ message: 'boom' }, 'failed'],
  ])('maps %j to %s', async (error, reason) => {
    h.rpcError = error;
    expect(
      await p.revokeOperator({
        userId: 'u2',
        actorUserId: 'u1',
        reason: REASON,
      })
    ).toEqual({ ok: false, reason });
  });
});
