import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 — `broadcast_recipients` on Resume / Retry failed.
//
// Resuming IS sending: a campaign abandoned after 1 000 of its 5 000
// recipients must not be able to deliver the other 4 000 with the
// allowance already spent, and what it does deliver has to be counted.
// The planner and the claim are stubbed; `deliverBroadcast` runs for
// real inside the stubbed `after()`.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  claim: vi.fn(async () => true),
  plan: vi.fn(),
  markSending: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  assertQuota: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.1' })),
  afterTasks: [] as (() => unknown)[],
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (cb: () => unknown) => {
    h.afterTasks.push(cb);
  },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: h.requireRole,
}));

vi.mock('@/lib/whatsapp/broadcast-resume', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/broadcast-resume')>()),
  claimBroadcastDelivery: h.claim,
  planBroadcastResume: h.plan,
  markBroadcastSending: h.markSending,
  releaseBroadcastDelivery: h.release,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertQuota: h.assertQuota,
  recordUsage: h.recordUsage,
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: (...args: unknown[]) =>
    (h.sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { broadcast: {} },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => adminDb.db,
}));

import { QuotaExceededError } from '@/lib/billing/enforce';
import { POST } from './route';

/** Records the recipient-row updates and answers the finalize counts. */
function fakeDb() {
  const updates: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      let status: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return chain;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcast_recipients') updates.push(row);
          return chain;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({ count: status === 'pending' ? 0 : 1, error: null }),
      };
      return chain;
    },
  };
  return { db, updates };
}

let adminDb: ReturnType<typeof fakeDb>;

function planFor(accountId: string, howMany: number) {
  return {
    plan: {
      broadcastId: 'b-1',
      accountId,
      templateName: 'promo',
      templateLanguage: 'en_US',
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      templateRow: null,
      planned: Array.from({ length: howMany }, (_, i) => ({
        recipientRowId: `r-${i}`,
        phone: `1555111000${i}`,
        params: [],
      })),
      rejected: 0,
    },
    remaining: 0,
    unsendable: 0,
  };
}

function post(body: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/broadcast/b-1/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'b-1' }) }
  );
}

async function runAfterTasks() {
  const tasks = [...h.afterTasks];
  h.afterTasks.length = 0;
  for (const task of tasks) await task();
}

beforeEach(() => {
  adminDb = fakeDb();
  h.afterTasks.length = 0;
  h.requireRole.mockReset();
  h.requireRole.mockResolvedValue({
    supabase: adminDb.db,
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Acme' },
  });
  h.claim.mockReset();
  h.claim.mockResolvedValue(true);
  h.plan.mockReset();
  h.plan.mockResolvedValue(planFor('acct-1', 2));
  h.markSending.mockReset();
  h.markSending.mockResolvedValue(undefined);
  h.release.mockReset();
  h.release.mockResolvedValue(undefined);
  h.assertQuota.mockReset();
  h.assertQuota.mockResolvedValue(undefined);
  h.recordUsage.mockReset();
  h.recordUsage.mockResolvedValue(undefined);
  h.sendTemplateMessage.mockReset();
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
});

describe('POST /api/whatsapp/broadcast/[id]/resume — broadcast_recipients (fase 3 §4)', () => {
  it('weighs the pass it is about to deliver', async () => {
    const res = await post();
    expect(res.status).toBe(202);
    expect(h.assertQuota).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      2
    );
  });

  it('402s a pass that does not fit, delivers to nobody and frees the claim', async () => {
    h.assertQuota.mockRejectedValue(
      new QuotaExceededError('broadcast_recipients', 1000, 1000)
    );

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe('quota_exceeded');
    expect(json.upgradeUrl).toBe('/billing');
    // The campaign was never flipped back to sending and nothing was
    // handed to the fan-out.
    expect(h.markSending).not.toHaveBeenCalled();
    await runAfterTasks();
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
    // …and the delivery claim is released, so raising the plan is
    // enough to resume — no waiting out the staleness window.
    expect(h.release).toHaveBeenCalled();
  });

  it('counts only what the pass actually delivered', async () => {
    h.sendTemplateMessage
      .mockResolvedValueOnce({ messageId: 'wamid.1' })
      .mockRejectedValueOnce(new Error('Meta said no'));

    await post();
    await runAfterTasks();

    expect(adminDb.updates.map((u) => u.status)).toEqual(['sent', 'failed']);
    expect(h.recordUsage).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      1
    );
  });

  it('bills the account that owns the campaign and no other (leak test)', async () => {
    h.requireRole.mockResolvedValue({
      supabase: adminDb.db,
      accountId: 'acct-other',
      userId: 'user-2',
      role: 'admin',
      account: { id: 'acct-other', name: 'Other' },
    });
    h.plan.mockResolvedValue(planFor('acct-other', 2));

    await post();
    await runAfterTasks();

    expect(h.assertQuota).toHaveBeenCalledWith(
      'acct-other',
      'broadcast_recipients',
      2
    );
    expect(h.recordUsage).toHaveBeenCalledWith(
      'acct-other',
      'broadcast_recipients',
      2
    );
    expect(h.recordUsage).not.toHaveBeenCalledWith(
      'acct-1',
      expect.anything(),
      expect.anything()
    );
    // The planner only ever looked at the caller's own account.
    expect(h.plan).toHaveBeenCalledWith(
      expect.anything(),
      'acct-other',
      'b-1',
      'pending'
    );
  });
});
