import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 — `broadcast_recipients` on the PUBLIC API.
//
// The point of putting the check in `broadcast-core` is that this route
// gets it for free: a Pro key must not be able to fan out campaign after
// campaign without anything being weighed or counted. The core runs for
// real here (only the billing layer, Meta and the contact/template
// lookups are stubbed), so what is asserted is the wiring, not a mock.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
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

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) =>
    (h.requireApiKey as unknown as (...a: unknown[]) => unknown)(...args),
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

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: async () => ({
    row: null,
    language: 'en_US',
    malformed: false,
  }),
}));

vi.mock('@/lib/api/v1/contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/contacts')>()),
  resolveAuditUserId: async () => 'user-1',
  // One contact per phone, so the dedup in createBroadcast does not
  // collapse the audience of these tests.
  findOrCreateContact: async (
    _db: unknown,
    _accountId: string,
    _userId: string,
    input: { phone: string }
  ) => ({ id: `c-${input.phone}` }),
}));

import { QuotaExceededError } from '@/lib/billing/enforce';
import { POST } from './route';

/**
 * Supabase-shaped stub: config lookup, the atomic create RPC (echoing
 * one recipient row per contact) and the recipient-row updates of the
 * fan-out.
 */
function fakeDb() {
  const updates: Record<string, unknown>[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    from(table: string) {
      let status: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcast_recipients') updates.push(row);
          return chain;
        },
        single: async () => ({
          data: { phone_number_id: 'pn-1', access_token: 'enc' },
          error: null,
        }),
        // Post-053 the sender number is the account default, read with
        // `.maybeSingle()` — `.single()` would error on the second number.
        maybeSingle: async () =>
          table === 'whatsapp_config'
            ? {
                data: {
                  id: 'cfg-1',
                  account_id: 'acct-1',
                  phone_number_id: 'pn-1',
                  access_token: 'enc',
                },
                error: null,
              }
            : { data: null, error: null },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({ count: status === 'pending' ? 0 : 1, error: null }),
      };
      return chain;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const contactIds = args.p_contact_ids as string[];
      return {
        data: contactIds.map((contactId, i) => ({
          broadcast_id: 'b-1',
          recipient_id: `r-${i}`,
          contact_id: contactId,
        })),
        error: null,
      };
    },
  };
  return { db, updates, rpcCalls };
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/v1/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

const CAMPAIGN = {
  template_name: 'promo',
  recipients: [{ to: '+14155550123' }, { to: '+14155550124' }],
};

async function runAfterTasks() {
  const tasks = [...h.afterTasks];
  h.afterTasks.length = 0;
  for (const task of tasks) await task();
}

let db: ReturnType<typeof fakeDb>;

beforeEach(() => {
  db = fakeDb();
  h.afterTasks.length = 0;
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue({
    supabase: db.db,
    accountId: 'acct-1',
    keyId: 'key-1',
  });
  h.assertQuota.mockReset();
  h.assertQuota.mockResolvedValue(undefined);
  h.recordUsage.mockReset();
  h.recordUsage.mockResolvedValue(undefined);
  h.sendTemplateMessage.mockReset();
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
});

describe('POST /api/v1/broadcasts — broadcast_recipients (fase 3 §4)', () => {
  it('weighs the whole campaign before persisting it', async () => {
    await post(CAMPAIGN);
    expect(h.assertQuota).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      2
    );
  });

  it('402s over the allowance, persists no campaign and messages nobody', async () => {
    h.assertQuota.mockRejectedValue(
      new QuotaExceededError('broadcast_recipients', 1000, 1000)
    );

    const res = await post(CAMPAIGN);
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.error.code).toBe('quota_exceeded');
    expect(json.error.metric).toBe('broadcast_recipients');
    expect(json.error.upgradeUrl).toBe('/billing');
    // Nothing persisted, nothing sent, nothing counted.
    expect(db.rpcCalls).toHaveLength(0);
    await runAfterTasks();
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('counts only the recipients Meta accepted', async () => {
    h.sendTemplateMessage
      .mockResolvedValueOnce({ messageId: 'wamid.1' })
      .mockRejectedValueOnce(new Error('Meta said no'));

    const res = await post(CAMPAIGN);
    expect(res.status).toBe(202);

    await runAfterTasks();

    expect(db.updates.map((u) => u.status)).toEqual(['sent', 'failed']);
    expect(h.recordUsage).toHaveBeenCalledWith(
      'acct-1',
      'broadcast_recipients',
      1
    );
  });

  it('weighs and bills the key holder and no other account (leak test)', async () => {
    h.requireApiKey.mockResolvedValue({
      supabase: db.db,
      accountId: 'acct-other',
      keyId: 'key-2',
    });

    await post(CAMPAIGN);
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
    expect(h.assertQuota).not.toHaveBeenCalledWith(
      'acct-1',
      expect.anything(),
      expect.anything()
    );
  });
});
