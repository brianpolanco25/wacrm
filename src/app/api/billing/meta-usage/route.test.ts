import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/billing/meta-usage (s10.5): the guard, the managed block
// («Consumo del ciclo», estimate at the cut-off, «tarifa pendiente») and
// the direct one (Meta's free quota per number from p11.3's count, and
// Meta's estimated cost). The A↔B leak is covered with both accounts
// seeded in `src/lib/security/tenant-isolation.test.ts` › «Meta usage».

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: h.requireRole,
}));

vi.mock('@/lib/flows/admin-client', async () => {
  const mod = await import('@/lib/security/fake-supabase');
  const forward = mod.forwardingClient(() => h.db.admin);
  return { supabaseAdmin: () => forward };
});

const { ForbiddenError, UnauthorizedError } =
  await import('@/lib/auth/account');
const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { GET } = await import('./route');

const A = 'acct-a';
const RD = '18095550000';
const PRICING = {
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
const RATES = [
  {
    market: 'rest_of_latam',
    category: 'service',
    usd_per_message: '0.01130',
    effective_from: '2026-10-01',
  },
  {
    market: 'rest_of_latam',
    category: 'marketing',
    usd_per_message: '0.07400',
    effective_from: '2026-10-01',
  },
];

function charges(
  n: number,
  category: string,
  billable = true,
  offsetMs = 0
): Record<string, unknown>[] {
  const base = Date.parse('2026-10-02T00:00:00.000Z') + offsetMs;
  return Array.from({ length: n }, (_, i) => ({
    id: `mc-${category}-${offsetMs}-${i}`,
    account_id: A,
    wamid: `wamid.${category}.${offsetMs}.${i}`,
    whatsapp_config_id: 'cfg-a',
    recipient_phone: RD,
    pricing_category: category,
    pricing_billable: billable,
    status: 'delivered',
    delivered_at: new Date(base + i * 1000).toISOString(),
  }));
}

function seed(
  sub: Record<string, unknown>,
  extra: Record<string, unknown[]> = {}
) {
  h.db = new FakeDatabase(
    {
      subscriptions: [{ id: 'sub-a', account_id: A, status: 'active', ...sub }],
      whatsapp_config: [
        {
          id: 'cfg-a',
          account_id: A,
          label: 'Ventas',
          display_phone_number: '+1 809 555 0001',
          is_default: true,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      statements: [],
      message_charges: [],
      meta_rates: RATES,
      meta_market_countries: [{ country_code: 'DO', market: 'rest_of_latam' }],
      ...(extra as Record<string, Record<string, unknown>[]>),
    },
    {
      service_quota_usage: () => [
        { whatsapp_config_id: 'cfg-a', used: 850, billable: 0 },
      ],
    }
  );
}

const MANAGED = {
  meta_billing: 'managed',
  meta_pricing: PRICING,
  payment_method: 'manual',
  provider: 'manual',
  statement_period_end: '2026-11-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  seed({});
  h.requireRole.mockReset().mockResolvedValue({
    accountId: A,
    userId: 'user-a',
    role: 'admin',
    impersonation: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the guard', () => {
  it('401s without a session and 403s below admin, reading nothing', async () => {
    h.requireRole.mockRejectedValueOnce(new UnauthorizedError());
    expect((await GET()).status).toBe(401);
    h.requireRole.mockRejectedValueOnce(
      new ForbiddenError("This action requires the 'admin' role or higher")
    );
    expect((await GET()).status).toBe(403);
    expect(h.db.log).toEqual([]);
  });

  it('asks for admin+ and stays reachable while the account is read-only', async () => {
    await GET();
    expect(h.requireRole).toHaveBeenCalledWith('admin', {
      allowReadOnly: true,
    });
  });
});

describe('managed: «Consumo del ciclo»', () => {
  it('package used over the included messages, overage by category and the estimate at the cut-off', async () => {
    seed(MANAGED, {
      message_charges: [
        ...charges(7000, 'marketing'),
        ...charges(1200, 'service', false, 10_000_000),
      ],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      metaBilling: 'managed',
      state: 'ok',
      periodStart: '2026-10-01T00:00:00.000Z',
      cutAt: '2026-11-01T00:00:00.000Z',
      includedMessages: 7000,
      packageUsed: 7000,
      overageMessages: 1200,
      alert: 'full',
      feeUsd: 1036,
      overageUsd: 33.9,
      estimatedTotalUsd: 1069.9,
    });
    // The customer never sees what is Cabbity's own business.
    expect(JSON.stringify(body)).not.toMatch(/billable|meta_rate|meta_cost/);
    // No Meta free-quota count for a managed account.
    expect(h.db.log.some((e) => e.table === 'rpc:service_quota_usage')).toBe(
      false
    );
  });

  it('every read of the service role carries the account', async () => {
    seed(MANAGED);
    await GET();
    for (const entry of h.db.log) {
      if (['meta_rates', 'meta_market_countries'].includes(entry.table)) {
        continue; // global catalogue (076), no account_id
      }
      expect(
        entry.filters.some((f) => f.column === 'account_id' && f.value === A),
        entry.table
      ).toBe(true);
    }
  });

  it('a missing Meta rate is «tarifa pendiente»: 200 with the package counted, never a broken panel', async () => {
    seed(MANAGED, {
      message_charges: charges(10, 'utility'),
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: 'rate_pending',
      packageUsed: 10,
      estimatedTotalUsd: null,
      missingRate: { market: 'rest_of_latam', category: 'utility' },
    });
  });

  it('the cycle starts at the last cut-off once the anchor has passed', async () => {
    seed(
      { ...MANAGED, statement_period_end: '2026-10-15T00:00:00.000Z' },
      {
        statements: [
          {
            id: 'st-1',
            account_id: A,
            period_end: '2026-10-15T00:00:00.000Z',
          },
        ],
        // Before the cut-off: on the statement already issued.
        message_charges: charges(5, 'marketing'),
      }
    );
    const body = await (await GET()).json();
    expect(body).toMatchObject({
      periodStart: '2026-10-15T00:00:00.000Z',
      cutAt: '2026-11-15T00:00:00.000Z',
      packageUsed: 0,
    });
  });
});

describe('direct: Meta’s free quota and estimated cost', () => {
  it('per number from service_quota_usage (p11.3), 80 % warning, and the cost of the billable ones only', async () => {
    seed(
      {},
      {
        message_charges: [
          ...charges(850, 'service', false),
          ...charges(100, 'marketing', true, 5_000_000),
        ],
      }
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      metaBilling: 'direct',
      state: 'ok',
      freeTier: 1000,
      monthStart: '2026-10-01T00:00:00.000Z',
      resetsAt: '2026-11-01T00:00:00.000Z',
      numbers: [
        {
          id: 'cfg-a',
          used: 850,
          percent: 85,
          alert: 'warn',
          exhausted: false,
        },
      ],
      metaCost: {
        totalUsd: 7.4,
        byCategory: [{ category: 'marketing', billable: 100, costUsd: 7.4 }],
      },
    });
    const rpc = h.db.log.filter((e) => e.table === 'rpc:service_quota_usage');
    expect(rpc).toHaveLength(1);
    expect(rpc[0].args).toEqual({
      p_account_id: A,
      p_since: '2026-10-01T00:00:00.000Z',
    });
  });

  it('a number that exhausted the quota is at 100 %', async () => {
    h.db.rpcHandlers.service_quota_usage = () => [
      { whatsapp_config_id: 'cfg-a', used: 400, billable: 3 },
    ];
    const body = await (await GET()).json();
    expect(body.numbers[0]).toMatchObject({
      percent: 100,
      alert: 'full',
      exhausted: true,
    });
  });

  it('a missing rate says «tarifa pendiente» and still shows the quota', async () => {
    seed({}, { message_charges: charges(3, 'utility') });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: 'rate_pending',
      metaCost: null,
      missingRate: { category: 'utility' },
      numbers: [{ id: 'cfg-a', used: 850 }],
    });
  });

  it('500s, without detail, when the count fails', async () => {
    h.db.rpcHandlers.service_quota_usage = () => ({
      data: null,
      error: { message: 'boom' },
    });
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Failed to load the Meta usage',
    });
  });
});
