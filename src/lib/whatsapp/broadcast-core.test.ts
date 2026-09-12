import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
} from './broadcast-core';

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
  // `resolve-config.ts` also asks whether the stored ciphertext is in
  // the pre-f2.3 CBC format, to self-heal it in the background.
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: (...args: unknown[]) =>
    (billing.findOrCreateContact as unknown as (...a: unknown[]) => unknown)(
      ...args
    ),
}));

// Fase 3 §4. The billing layer is stubbed at its entry points; the real
// `QuotaExceededError` travels, so what the routes map to a 402 is what
// these tests raise.
const billing = vi.hoisted(() => ({
  // Contact resolution WRITES (it creates the ones that don't exist),
  // which is why the quota has to be weighed before it runs.
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
  assertQuota: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.1' })),
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertQuota: billing.assertQuota,
  recordUsage: billing.recordUsage,
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: (...args: unknown[]) =>
    (billing.sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(
      ...args
    ),
}));

import { QuotaExceededError } from '@/lib/billing/enforce';

beforeEach(() => {
  billing.findOrCreateContact.mockReset();
  billing.findOrCreateContact.mockResolvedValue({ id: 'c1' });
  billing.assertQuota.mockReset();
  billing.assertQuota.mockResolvedValue(undefined);
  billing.recordUsage.mockReset();
  billing.recordUsage.mockResolvedValue(undefined);
  billing.sendTemplateMessage.mockReset();
  billing.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
});

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Build a Supabase-shaped mock that gets createBroadcast past its config +
// template lookups and into persistence. `rpcResult` is what the atomic
// create_broadcast_with_recipients RPC returns.
function makeDb(rpcResult: { data: unknown; error: unknown }) {
  const calls = {
    rpc: [] as { name: string; args: unknown }[],
    // Incremented if the OLD non-atomic path (a direct broadcasts /
    // broadcast_recipients insert) is ever reached — it must not be.
    usedDirectInsert: 0,
  };
  const database = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        // Post-053 the sender is resolved by `resolve-config.ts`: with
        // no explicit choice it reads the account default, which ends
        // on `.maybeSingle()` rather than the old `.single()`.
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: {
                id: 'cfg-1',
                account_id: 'acc',
                phone_number_id: 'pn-1',
                access_token: 'enc',
              },
              error: null,
            }),
        };
        return chain;
      }
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        const chain: Record<string, unknown> = {
          insert: () => {
            // Only an INSERT here is the old non-atomic path. The UPDATE
            // that stamps `whatsapp_config_id` on the row the RPC just
            // created (migration 053) is not.
            calls.usedDirectInsert++;
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: 'orphan' }, error: null }),
              }),
            };
          },
          update: () => chain,
          eq: () => chain,
          then: (resolve: (v: { data: null; error: null }) => void) =>
            resolve({ data: null, error: null }),
        };
        return chain;
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
  return { db: database, calls };
}

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe('create_broadcast_with_recipients');
    expect(calls.usedDirectInsert).toBe(0);
    expect(plan.broadcastId).toBe('b-1');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
    ]);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    const { db, calls } = makeDb({
      data: null,
      error: { message: 'recipient insert failed' },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);

    // The RPC was the only persistence attempt; because it runs both
    // inserts in a single transaction, its failure rolls the parent back —
    // there is no separate parent insert that could survive as an orphan.
    expect(calls.rpc).toHaveLength(1);
    expect(calls.usedDirectInsert).toBe(0);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> }
) {
  return {
    from(table: string) {
      let status: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 25 }, 1025, writes),
      'b-1'
    );
    // No write at all — the UI keeps offering Resume.
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 10 }, 10, writes),
      'b-1'
    );
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 3 }, 10, writes),
      'b-1'
    );
    // 7 people got the message; failed_count carries the other 3.
    expect(writes.update?.status).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 200 }, 1000, writes),
      'b-1'
    );
    expect(writes.update?.status).toBe('sent');
  });
});

// ============================================================
// Fase 3 §4 — `broadcast_recipients` lives in the core, not in one
// route: `/api/v1/broadcasts`, the dashboard's Resume and Retry all
// fan out through these two functions. A limit honoured by one caller
// is not a limit.
// ============================================================

describe('createBroadcast — broadcast_recipients (fase 3 §4)', () => {
  it('weighs the whole campaign before writing anything at all', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }, { to: '+14155550124' }],
    });

    // Two distinct numbers: that is the weight, even though the contact
    // stub collapses them onto one contact afterwards. The check runs
    // before contacts are resolved — it WRITES — and at that point the
    // distinct valid phones are all there is to go on.
    expect(billing.assertQuota).toHaveBeenCalledWith(
      'acc',
      'broadcast_recipients',
      2
    );
    expect(calls.rpc).toHaveLength(1);
  });

  it('weighs a number the caller listed twice once', async () => {
    const { db } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }, { to: '+1 415 555 0123' }],
    });

    expect(billing.assertQuota).toHaveBeenCalledWith(
      'acc',
      'broadcast_recipients',
      1
    );
  });

  it('refuses over the limit and persists no campaign — nor any contact', async () => {
    billing.assertQuota.mockRejectedValue(
      new QuotaExceededError('broadcast_recipients', 1000, 1000)
    );
    const { db, calls } = makeDb({ data: [], error: null });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }, { to: '+14155550124' }],
      })
    ).rejects.toBeInstanceOf(QuotaExceededError);

    // Nothing persisted: no half-created campaign to clean up, and
    // nobody was messaged.
    expect(calls.rpc).toHaveLength(0);
    expect(calls.usedDirectInsert).toBe(0);
    // And no contacts either. `findOrCreateContact` creates the ones
    // that don't exist, so running it before the cap turned a refused
    // campaign into an import of up to a thousand strangers.
    expect(billing.findOrCreateContact).not.toHaveBeenCalled();
  });

  it('weighs the caller account and no other (leak test)', async () => {
    const { db } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });
    await createBroadcast(db, 'acct-other', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });
    expect(billing.assertQuota).toHaveBeenCalledWith(
      'acct-other',
      'broadcast_recipients',
      1
    );
  });
});

/**
 * Supabase-shaped stub for a fan-out: records every recipient-row
 * update and answers the counting queries of `finalizeBroadcastStatus`.
 */
function deliverDb() {
  const updates: Record<string, unknown>[] = [];
  const database = {
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
  } as unknown as SupabaseClient;
  return { db: database, updates };
}

function planOf(accountId: string, phones: string[]) {
  return {
    broadcastId: 'b-1',
    accountId,
    templateName: 'promo',
    templateLanguage: 'en_US',
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
    templateRow: null,
    planned: phones.map((phone, i) => ({
      recipientRowId: `r-${i}`,
      phone,
      params: [],
    })),
    rejected: 0,
  };
}

describe('deliverBroadcast — broadcast_recipients (fase 3 §4)', () => {
  it('refuses the pass over the limit and messages nobody', async () => {
    billing.assertQuota.mockRejectedValue(
      new QuotaExceededError('broadcast_recipients', 1000, 999)
    );
    const { db, updates } = deliverDb();

    await expect(
      deliverBroadcast(db, planOf('acc', ['14155550123', '14155550124']))
    ).rejects.toBeInstanceOf(QuotaExceededError);

    expect(billing.assertQuota).toHaveBeenCalledWith(
      'acc',
      'broadcast_recipients',
      2
    );
    expect(billing.sendTemplateMessage).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(billing.recordUsage).not.toHaveBeenCalled();
  });

  it('counts only the recipients Meta accepted', async () => {
    billing.sendTemplateMessage
      .mockResolvedValueOnce({ messageId: 'wamid.1' })
      .mockRejectedValueOnce(new Error('Meta said no'));
    const { db, updates } = deliverDb();

    await deliverBroadcast(db, planOf('acc', ['14155550123', '14155550124']));

    expect(updates.map((u) => u.status)).toEqual(['sent', 'failed']);
    expect(billing.recordUsage).toHaveBeenCalledWith(
      'acc',
      'broadcast_recipients',
      1
    );
  });

  it('bills the account on the plan and no other (leak test)', async () => {
    const { db } = deliverDb();
    await deliverBroadcast(db, planOf('acct-other', ['14155550123']));
    expect(billing.assertQuota).toHaveBeenCalledWith(
      'acct-other',
      'broadcast_recipients',
      1
    );
    expect(billing.recordUsage).toHaveBeenCalledWith(
      'acct-other',
      'broadcast_recipients',
      1
    );
  });
});
