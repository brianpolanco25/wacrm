import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 — `broadcast_recipients`.
//
// The unit is the CAMPAIGN, not the request: the wizard splits a
// campaign into batches of ten, so weighing `recipients.length` would
// let a large blast through its first batches and refuse the last one,
// leaving exactly the half-delivered campaign §4 sets out to avoid.
// With a `broadcast_id` the route weighs the campaign's outstanding
// ('pending') recipients instead — on the first batch that is the whole
// campaign — and counts afterwards only what actually left.
//
// `requireRole` and the enforcement layer are stubbed at their entry
// points; `toErrorResponse` and the error classes stay real, so the
// 402 body below is the one the route really produces.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  // Typed so `mockImplementation` below can read the amount being
  // weighed — that argument is the whole point of these tests.
  assertQuota: vi.fn<
    (accountId: string, metric: string, n: number) => Promise<void>
  >(async () => {}),
  recordUsage: vi.fn(async () => {}),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.1' })),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertQuota: mocks.assertQuota,
  recordUsage: mocks.recordUsage,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { broadcast: {} },
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: (...args: unknown[]) =>
    (mocks.sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(
      ...args
    ),
  // Fase 2 (private media) routes the template header through
  // `resolveTemplateHeaderMedia`, which reads this export at module
  // scope. Without it the whole pass fails up front and nothing is sent,
  // which would read here as "the fase 3 counter is broken".
  uploadMedia: vi.fn(async () => ({ mediaId: 'meta-media-1' })),
}));

// Fase 2 (private media): the route resolves the template header
// through `resolveTemplateHeaderMedia`, and passes it a service-role
// client built here. Unmocked it tries to build a real one and every
// recipient fails with "supabaseUrl is required" — which would read as
// "the fase 3 counter never counts". The template row is null in these
// tests, so nothing is actually read through it.
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({}), storage: {} }),
}));

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: async () => ({
    row: null,
    language: 'en_US',
    malformed: false,
  }),
}));

import { QuotaExceededError } from '@/lib/billing/enforce';
import { POST } from './route';

/**
 * `pending` is how many recipients of the persisted campaign are still
 * outstanding; `campaignOwned: false` makes the `broadcasts` lookup
 * come back empty, which is what another tenant's id looks like.
 */
function supabaseMock({
  pending = 0,
  campaignOwned = true,
  countError = null as { message: string } | null,
} = {}) {
  const seen = { broadcastFilters: [] as [string, unknown][] };
  return {
    seen,
    client: {
      from: (table: string) => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            if (table === 'broadcasts') seen.broadcastFilters.push([col, val]);
            return chain;
          },
          single: async () => ({
            data: {
              id: 'cfg-1',
              account_id: 'acct-1',
              phone_number_id: 'pn-1',
              access_token: 'token',
            },
            error: null,
          }),
          maybeSingle: async () => ({
            data: campaignOwned ? { id: 'bc-1' } : null,
            error: null,
          }),
          // The head/count query of the outstanding-recipient lookup.
          then: (resolve: (r: unknown) => unknown) =>
            resolve({ count: pending, error: countError }),
        };
        return chain;
      },
    },
  };
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

const CAMPAIGN = {
  template_name: 'promo',
  template_language: 'en_US',
  recipients: [
    { phone: '+15551110001' },
    { phone: '+15551110002' },
    { phone: '+15551110003' },
  ],
};

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.requireRole.mockResolvedValue({
    supabase: supabaseMock().client,
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Acme' },
  });
  mocks.assertQuota.mockReset();
  mocks.assertQuota.mockResolvedValue(undefined);
  mocks.recordUsage.mockReset();
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.sendTemplateMessage.mockReset();
  mocks.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
});

/** The wizard's batch: ten of the campaign's recipients. */
const BATCH_OF_TEN = Array.from({ length: 10 }, (_, i) => ({
  phone: `+1555111${String(i).padStart(4, '0')}`,
}));

/**
 * `used` of `limit` already spent — i.e. `limit - used` left. Lets a
 * test state its margin instead of pre-computing which call throws.
 */
function allowanceLeft(margin: number) {
  const limit = 2000;
  const used = limit - margin;
  mocks.assertQuota.mockImplementation(async (_accountId, _metric, n) => {
    if (used + n > limit) {
      throw new QuotaExceededError('broadcast_recipients', limit, used);
    }
  });
}

describe('POST /api/whatsapp/broadcast — broadcast_recipients (fase 3 §4)', () => {
  it('checks the whole campaign as one batch, before the first send', async () => {
    // No `broadcast_id`: a direct caller is weighed by the only thing
    // it says about itself, its own recipient list.
    await post(CAMPAIGN);
    expect(mocks.assertQuota).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      3
    );
  });

  it('weighs the campaign, not the batch of ten the wizard sends', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: supabaseMock({ pending: 25 }).client,
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'admin',
      account: { id: 'acct-1', name: 'Acme' },
    });

    await post({ ...CAMPAIGN, broadcast_id: 'bc-1', recipients: BATCH_OF_TEN });

    expect(mocks.assertQuota).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      25
    );
  });

  it('402s a campaign of 25 with 20 left in the allowance, before the first send', async () => {
    // The decision of §4, fixed: per BATCH this request (10 ≤ 20) would
    // sail through and the campaign would die on its third batch, half
    // delivered and un-retryable. Per CAMPAIGN it is refused now, while
    // nothing has gone out.
    mocks.requireRole.mockResolvedValue({
      supabase: supabaseMock({ pending: 25 }).client,
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'admin',
      account: { id: 'acct-1', name: 'Acme' },
    });
    allowanceLeft(20);

    const res = await post({
      ...CAMPAIGN,
      broadcast_id: 'bc-1',
      recipients: BATCH_OF_TEN,
    });
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe('quota_exceeded');
    expect(json.metric).toBe('broadcast_recipients');
    expect(json.upgradeUrl).toBe('/billing');
    expect(mocks.sendTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('delivers the batch and counts it when the campaign fits', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: supabaseMock({ pending: 25 }).client,
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'admin',
      account: { id: 'acct-1', name: 'Acme' },
    });
    allowanceLeft(30);

    const res = await post({
      ...CAMPAIGN,
      broadcast_id: 'bc-1',
      recipients: BATCH_OF_TEN,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.sent).toBe(10);
    expect(mocks.sendTemplateMessage).toHaveBeenCalledTimes(10);
    // Counted per request, for what left: the 25 of the campaign are
    // weighed, never charged twice.
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      10
    );
  });

  it('never weighs less than the recipients in the request', async () => {
    // A campaign whose rows were already stamped (a stale count) must
    // not wave this batch through for free.
    mocks.requireRole.mockResolvedValue({
      supabase: supabaseMock({ pending: 0 }).client,
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'admin',
      account: { id: 'acct-1', name: 'Acme' },
    });

    await post({ ...CAMPAIGN, broadcast_id: 'bc-1' });

    expect(mocks.assertQuota).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      3
    );
  });

  it('404s a campaign id that belongs to another account (leak test)', async () => {
    const mock = supabaseMock({ campaignOwned: false });
    mocks.requireRole.mockResolvedValue({
      supabase: mock.client,
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'admin',
      account: { id: 'acct-1', name: 'Acme' },
    });

    const res = await post({ ...CAMPAIGN, broadcast_id: 'bc-of-other-tenant' });

    expect(res.status).toBe(404);
    // The lookup was scoped to the caller's account, so another
    // tenant's campaign is invisible — and unchargeable.
    expect(mock.seen.broadcastFilters).toContainEqual(['account_id', 'acct-1']);
    expect(mocks.sendTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('fails closed when the campaign cannot be measured', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: supabaseMock({ countError: { message: 'boom' } }).client,
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'admin',
      account: { id: 'acct-1', name: 'Acme' },
    });

    const res = await post({ ...CAMPAIGN, broadcast_id: 'bc-1' });

    expect(res.status).toBe(500);
    expect(mocks.assertQuota).not.toHaveBeenCalled();
    expect(mocks.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('402s over the limit and sends to nobody', async () => {
    mocks.assertQuota.mockRejectedValue(
      new QuotaExceededError('broadcast_recipients', 2000, 1999)
    );

    const res = await post(CAMPAIGN);
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe('quota_exceeded');
    expect(json.metric).toBe('broadcast_recipients');
    expect(json.limit).toBe(2000);
    expect(json.upgradeUrl).toBe('/billing');
    expect(mocks.sendTemplateMessage).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('counts only the recipients that actually received the message', async () => {
    // Second number is refused by Meta; third is not a valid phone at
    // all. Neither is a recipient the customer reached, so neither is
    // billable.
    mocks.sendTemplateMessage
      .mockResolvedValueOnce({ messageId: 'wamid.1' })
      .mockRejectedValueOnce(new Error('Meta said no'));

    const res = await post({
      ...CAMPAIGN,
      recipients: [
        { phone: '+15551110001' },
        { phone: '+15551110002' },
        { phone: 'not-a-phone' },
      ],
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.sent).toBe(1);
    expect(json.failed).toBe(2);
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      1
    );
  });

  it('counts against the caller account and no other (leak test)', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: supabaseMock().client,
      accountId: 'acct-other',
      userId: 'user-2',
      role: 'admin',
      account: { id: 'acct-other', name: 'Other' },
    });
    await post(CAMPAIGN);
    expect(mocks.assertQuota).toHaveBeenCalledWith(
      'acct-other',
      'broadcast_recipients',
      3
    );
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      'acct-other',
      'broadcast_recipients',
      3
    );
  });

  it('does not check or count a request that never reached a recipient list', async () => {
    const res = await post({ template_name: 'promo' });
    expect(res.status).toBe(400);
    expect(mocks.assertQuota).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });
});
