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
      current_period_end: null,
      cancel_at_period_end: false,
      // s10.3: a plan with no Meta price policy leaves managed billing.
      payment_method: null,
      meta_billing: 'direct',
      meta_pricing: {},
      // s10.4: no statement anchor outside managed billing.
      statement_period_end: null,
    });
    // A suspension is its own axis (058): giving a plan must not lift it.
    expect(Object.keys(row).some((k) => k.startsWith('manual_hold'))).toBe(
      false
    );
  });
});

describe('manualPlanRow with managed terms (s10.3)', () => {
  const PRICING = {
    included_messages: 7000,
    fee_usd: 1036,
    overage: {
      service: { multiplier: 2.5 },
      utility: { multiplier: 2.5 },
      marketing: { usd_per_message: 0.2 },
      authentication: { multiplier: 2.5 },
      authentication_international: { multiplier: 2.5 },
    },
  };

  it('is active, monthly, first cut-off one month from now, with the price', () => {
    const row = p.manualPlanRow(
      A,
      'gestionado',
      { paymentMethod: 'manual', metaBilling: 'managed', metaPricing: PRICING },
      new Date('2026-10-01T15:00:00.000Z')
    );
    expect(row).toMatchObject({
      provider: 'manual',
      status: 'active',
      cycle: 'month',
      current_period_end: '2026-11-01T15:00:00.000Z',
      // s10.4 (078): the statement anchor starts equal to the period.
      statement_period_end: '2026-11-01T15:00:00.000Z',
      payment_method: 'manual',
      meta_billing: 'managed',
      meta_pricing: PRICING,
      provider_subscription_id: null,
      grace_until: null,
    });
  });

  it('clamps the month: from the 31st of January to the 28th of February', () => {
    const row = p.manualPlanRow(
      A,
      'gestionado',
      { paymentMethod: 'manual', metaBilling: 'managed', metaPricing: PRICING },
      new Date('2027-01-31T00:00:00.000Z')
    );
    expect(row.current_period_end).toBe('2027-02-28T00:00:00.000Z');
  });

  it('without «Meta lo paga Cabbity»: direct, and no price is stored', () => {
    const row = p.manualPlanRow(A, 'gestionado', {
      paymentMethod: 'manual',
      metaBilling: 'direct',
      metaPricing: PRICING,
    });
    expect(row.meta_billing).toBe('direct');
    expect(row.meta_pricing).toEqual({});
    expect(row.payment_method).toBe('manual');
    expect(row.statement_period_end).toBeNull();
  });
});

describe('managedStatementAnchor (s10.4)', () => {
  const NOW = new Date('2026-10-01T00:00:00.000Z');
  it('keeps the anchor of an account already managed', () => {
    expect(
      p.managedStatementAnchor(
        {
          meta_billing: 'managed',
          statement_period_end: '2026-10-20T00:00:00.000Z',
        },
        NOW
      )
    ).toBe('2026-10-20T00:00:00.000Z');
  });
  it('a new one, a month on, for an account that becomes managed or has no anchor', () => {
    const next = '2026-11-01T00:00:00.000Z';
    expect(p.managedStatementAnchor(null, NOW)).toBe(next);
    expect(
      p.managedStatementAnchor(
        {
          meta_billing: 'direct',
          statement_period_end: '2026-10-20T00:00:00.000Z',
        },
        NOW
      )
    ).toBe(next);
    expect(
      p.managedStatementAnchor(
        { meta_billing: 'managed', statement_period_end: null },
        NOW
      )
    ).toBe(next);
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

describe('overridePlan with a plan that carries a Meta price policy (s10.3)', () => {
  const DEFAULT = {
    included_messages: 7000,
    fee_usd: 1036,
    overage: {
      service: { multiplier: 2.5 },
      utility: { multiplier: 2.5 },
      marketing: { multiplier: 2.5 },
      authentication: { multiplier: 2.5 },
      authentication_international: { multiplier: 2.5 },
    },
  };
  function params(extra: Record<string, unknown> = {}) {
    return {
      accountId: A,
      accountName: 'Company A',
      planId: 'gestionado',
      actorUserId: OPERATOR,
      reason: REASON,
      now: new Date('2026-10-01T00:00:00.000Z'),
      ...extra,
    };
  }
  beforeEach(() => {
    h.results['plans:select'] = {
      data: { id: 'gestionado', meta_pricing: DEFAULT },
      error: null,
    };
  });

  it('refuses it without terms (needs_terms) and writes nothing', async () => {
    expect(await p.overridePlan(params())).toEqual({
      ok: false,
      reason: 'needs_terms',
    });
    expect(h.audit).toEqual([]);
    expect(h.calls.some((c) => c.op === 'upsert')).toBe(false);
  });

  it('copies the plan default when no price is given, and logs method, meta_billing and price', async () => {
    const out = await p.overridePlan(
      params({
        terms: {
          paymentMethod: 'manual',
          metaBilling: 'managed',
          metaPricing: null,
        },
      })
    );
    expect(out.ok).toBe(true);
    expect(h.audit[0].details).toMatchObject({
      to_plan: 'gestionado',
      payment_method: 'manual',
      meta_billing: 'managed',
      meta_pricing: DEFAULT,
      current_period_end: '2026-11-01T00:00:00.000Z',
    });
    const write = h.calls.find((c) => c.op === 'upsert')!;
    expect(write.payload).toMatchObject({
      account_id: A,
      plan_id: 'gestionado',
      payment_method: 'manual',
      meta_billing: 'managed',
      meta_pricing: DEFAULT,
      cycle: 'month',
    });
    const order = h.calls.map((c) => `${c.table}:${c.op}`);
    expect(order.indexOf('AUDIT:insert')).toBeLessThan(
      order.indexOf('subscriptions:upsert')
    );
  });

  it('a company that was already managed keeps its cut-off anchor, and the period follows it', async () => {
    h.results['subscriptions:select'] = {
      data: {
        plan_id: 'gestionado',
        provider: 'manual',
        status: 'active',
        provider_subscription_id: null,
        meta_billing: 'managed',
        meta_pricing: DEFAULT,
        payment_method: 'manual',
        statement_period_end: '2026-10-20T00:00:00.000Z',
      },
      error: null,
    };
    const out = await p.overridePlan(
      params({
        terms: {
          paymentMethod: 'manual',
          metaBilling: 'managed',
          metaPricing: null,
        },
      })
    );
    expect(out.ok).toBe(true);
    const write = h.calls.find((c) => c.op === 'upsert')!;
    expect(write.payload).toMatchObject({
      statement_period_end: '2026-10-20T00:00:00.000Z',
      current_period_end: '2026-10-20T00:00:00.000Z',
    });
  });

  it('a company that becomes managed now (it was direct) gets a new anchor, a month from the assignment', async () => {
    h.results['subscriptions:select'] = {
      data: {
        plan_id: 'inicio',
        provider: 'manual',
        status: 'active',
        provider_subscription_id: null,
        meta_billing: 'direct',
        meta_pricing: {},
        payment_method: null,
        // Stale: a direct account's anchor is never reused.
        statement_period_end: '2026-10-20T00:00:00.000Z',
      },
      error: null,
    };
    await p.overridePlan(
      params({
        terms: {
          paymentMethod: 'manual',
          metaBilling: 'managed',
          metaPricing: null,
        },
      })
    );
    const write = h.calls.find((c) => c.op === 'upsert')!;
    expect(write.payload).toMatchObject({
      statement_period_end: '2026-11-01T00:00:00.000Z',
      current_period_end: '2026-11-01T00:00:00.000Z',
    });
  });

  it('stores the edited price, not the default', async () => {
    const edited = { ...DEFAULT, fee_usd: 900, included_messages: 5000 };
    await p.overridePlan(
      params({
        terms: {
          paymentMethod: 'manual',
          metaBilling: 'managed',
          metaPricing: edited,
        },
      })
    );
    const write = h.calls.find((c) => c.op === 'upsert')!;
    expect((write.payload as Record<string, unknown>).meta_pricing).toEqual(
      edited
    );
  });
});

describe('listPlanOptions (s10.3)', () => {
  it('hands back the default Meta price of a plan that has one, null otherwise', async () => {
    const pricing = {
      included_messages: 7000,
      fee_usd: 1036,
      overage: {
        service: { multiplier: 2.5 },
        utility: { multiplier: 2.5 },
        marketing: { multiplier: 2.5 },
        authentication: { multiplier: 2.5 },
        authentication_international: { multiplier: 2.5 },
      },
    };
    h.results['plans:select'] = {
      data: [
        { id: 'pro', name: 'Pro', is_public: true, meta_pricing: {} },
        {
          id: 'gestionado',
          name: 'Gestionado',
          is_public: false,
          meta_pricing: pricing,
        },
        // Malformed: never offered as a price to start from.
        {
          id: 'roto',
          name: 'Roto',
          is_public: false,
          meta_pricing: { fee_usd: 'x' },
        },
      ],
      error: null,
    };
    expect(await p.listPlanOptions()).toEqual([
      { id: 'pro', name: 'Pro', isPublic: true, metaPricing: null },
      {
        id: 'gestionado',
        name: 'Gestionado',
        isPublic: false,
        metaPricing: pricing,
      },
      { id: 'roto', name: 'Roto', isPublic: false, metaPricing: null },
    ]);
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
