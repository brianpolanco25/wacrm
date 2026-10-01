import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/billing/broadcast-estimate (s10.5): the figure shown on the
// scheduling step. Information only — a missing rate is a 200 with
// `ratePending`, never an error that could stop a send (CP11). The A↔B
// leak is in `src/lib/security/tenant-isolation.test.ts` › «Meta usage».

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

const { ForbiddenError } = await import('@/lib/auth/account');
const { FakeDatabase } = await import('@/lib/security/fake-supabase');
const { GET } = await import('./route');

const A = 'acct-a';
const PRICING = {
  included_messages: 7000,
  fee_usd: 1036,
  overage: {
    service: { multiplier: 2.5 },
    utility: { usd_per_message: 0.03 },
    marketing: { multiplier: 2.5 },
    authentication: { multiplier: 2.5 },
    authentication_international: { multiplier: 2.5 },
  },
};
const MANAGED = {
  meta_billing: 'managed',
  meta_pricing: PRICING,
  payment_method: 'manual',
  provider: 'manual',
  statement_period_end: '2026-11-01T00:00:00.000Z',
};

function delivered(n: number): Record<string, unknown>[] {
  const base = Date.parse('2026-10-02T00:00:00.000Z');
  return Array.from({ length: n }, (_, i) => ({
    id: `mc-${i}`,
    account_id: A,
    wamid: `wamid.${i}`,
    whatsapp_config_id: 'cfg-a',
    recipient_phone: '18095550000',
    pricing_category: 'marketing',
    pricing_billable: true,
    status: 'delivered',
    delivered_at: new Date(base + i * 1000).toISOString(),
  }));
}

function seed(
  sub: Record<string, unknown>,
  opts: { rates?: boolean; charges?: Record<string, unknown>[] } = {}
) {
  h.db = new FakeDatabase({
    subscriptions: [{ id: 'sub-a', account_id: A, status: 'active', ...sub }],
    whatsapp_config: [
      {
        id: 'cfg-us',
        account_id: A,
        display_phone_number: '+1 415 555 0100',
        is_default: false,
        created_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'cfg-a',
        account_id: A,
        display_phone_number: '+1 809 555 0001',
        is_default: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'cfg-b',
        account_id: 'acct-b',
        display_phone_number: '+52 55 5555 0000',
        is_default: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    statements: [],
    message_charges: opts.charges ?? [],
    meta_rates:
      opts.rates === false
        ? []
        : [
            {
              market: 'rest_of_latam',
              category: 'marketing',
              usd_per_message: '0.07400',
              effective_from: '2026-10-01',
            },
          ],
    meta_market_countries: [{ country_code: 'DO', market: 'rest_of_latam' }],
  });
}

function estimate(query: string) {
  return GET(
    new Request(`http://localhost/api/billing/broadcast-estimate?${query}`)
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  seed({});
  h.requireRole.mockReset().mockResolvedValue({
    accountId: A,
    userId: 'user-a',
    role: 'agent',
    impersonation: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the guard and the input', () => {
  it('asks for agent+ (whoever can send a broadcast), reachable while read-only', async () => {
    await estimate('recipients=1');
    expect(h.requireRole).toHaveBeenCalledWith('agent', {
      allowReadOnly: true,
    });
  });

  it('403s a viewer and reads nothing', async () => {
    h.requireRole.mockRejectedValueOnce(
      new ForbiddenError("This action requires the 'agent' role or higher")
    );
    expect((await estimate('recipients=1')).status).toBe(403);
    expect(h.db.log).toEqual([]);
  });

  it('400s a recipients value that is not a whole number', async () => {
    for (const q of ['', 'recipients=-1', 'recipients=1.5', 'recipients=x']) {
      expect((await estimate(q)).status).toBe(400);
    }
  });
});

describe('direct', () => {
  it('«{n} destinatarios × tarifa de marketing» from rateFor in the market of the default number', async () => {
    const res = await estimate('recipients=1000');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      metaBilling: 'direct',
      recipients: 1000,
      category: 'marketing',
      market: 'rest_of_latam',
      ratePending: false,
      unitUsd: 0.074,
      totalUsd: 74,
    });
  });

  it('no rate loaded for the market of the number: 200 with ratePending, the send is not blocked', async () => {
    const res = await estimate('recipients=1000&whatsappConfigId=cfg-us');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      market: 'rest_of_world',
      ratePending: true,
      totalUsd: null,
    });
  });

  it("another company's number is a 404, and its market is never looked at", async () => {
    const res = await estimate('recipients=10&whatsappConfigId=cfg-b');
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('cfg-b');
  });
});

describe('managed', () => {
  it('how many fit in the package and how many go to overage, at the account’s price', async () => {
    seed(MANAGED, { charges: delivered(6500) });
    const res = await estimate('recipients=1000&category=marketing');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      metaBilling: 'managed',
      recipients: 1000,
      category: 'marketing',
      market: 'rest_of_latam',
      ratePending: false,
      remaining: 500,
      inPackage: 500,
      overage: 500,
      unitPriceUsd: 0.185,
      overageUsd: 92.5,
    });
    // Meta's rate is internal for a managed account.
    expect(body).not.toHaveProperty('unitUsd');
  });

  it('a fixed price per message needs no rate', async () => {
    seed(MANAGED, { charges: delivered(7000), rates: false });
    expect(
      await (await estimate('recipients=10&category=Utility')).json()
    ).toMatchObject({
      category: 'utility',
      inPackage: 0,
      overage: 10,
      unitPriceUsd: 0.03,
      overageUsd: 0.3,
      ratePending: false,
    });
  });

  it('a multiplier with no rate loaded: the split is still there, the price is pending', async () => {
    seed(MANAGED, { charges: delivered(6990), rates: false });
    expect(await (await estimate('recipients=20')).json()).toMatchObject({
      inPackage: 10,
      overage: 10,
      unitPriceUsd: null,
      overageUsd: null,
      ratePending: true,
    });
  });
});
