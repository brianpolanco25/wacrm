import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 — `broadcast_recipients`.
//
// A campaign is checked as ONE batch before the first send (refusing
// halfway leaves the operator with a half-delivered blast and no way to
// tell which half went) and counted afterwards for what actually left.
//
// `requireRole` and the enforcement layer are stubbed at their entry
// points; `toErrorResponse` and the error classes stay real, so the
// 402 body below is the one the route really produces.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  assertQuota: vi.fn(async () => {}),
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

function supabaseMock() {
  return {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({
          data: {
            id: 'cfg-1',
            account_id: 'acct-1',
            phone_number_id: 'pn-1',
            access_token: 'token',
          },
          error: null,
        }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return chain;
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
    supabase: supabaseMock(),
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

describe('POST /api/whatsapp/broadcast — broadcast_recipients (fase 3 §4)', () => {
  it('checks the whole campaign as one batch, before the first send', async () => {
    await post(CAMPAIGN);
    expect(mocks.assertQuota).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      3
    );
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
      supabase: supabaseMock(),
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
