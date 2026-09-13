import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  claimInboundAutoReply,
  claimInboundAutoReplyForAutomation,
} from './reply-marker';

/**
 * A stand-in for `inbound_auto_replies` that honours what migration 051
 * actually guarantees: a primary key on `message_id` alone. Everything
 * the feature promises — "the customer never gets two automatic replies
 * to the same message" — rests on that single-winner insert, so the fake
 * models the conflict rather than the call.
 */
function fakeDb(
  options: { error?: { message: string }; readError?: { message: string } } = {}
) {
  const rows = new Map<string, Record<string, unknown>>();
  const upserts: { payload: Record<string, unknown>; opts: unknown }[] = [];
  const reads: Record<string, unknown>[] = [];

  const db = {
    from: (table: string) => {
      if (table !== 'inbound_auto_replies') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        // Holder lookup: select(...).eq('message_id').eq('account_id')
        //  .maybeSingle()
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq: (column: string, value: unknown) => {
              filters[column] = value;
              return chain;
            },
            maybeSingle: () => {
              reads.push(filters);
              if (options.readError) {
                return Promise.resolve({
                  data: null,
                  error: options.readError,
                });
              }
              const row = rows.get(filters.message_id as string);
              return Promise.resolve({
                data: row && row.account_id === filters.account_id ? row : null,
                error: null,
              });
            },
          };
          return chain;
        },
        upsert: (payload: Record<string, unknown>, opts: unknown) => {
          upserts.push({ payload, opts });
          return {
            select: () => {
              if (options.error) {
                return Promise.resolve({ data: null, error: options.error });
              }
              const key = payload.message_id as string;
              // ON CONFLICT DO NOTHING: the row comes back only on a
              // genuine insert.
              if (rows.has(key)) {
                return Promise.resolve({ data: [], error: null });
              }
              rows.set(key, payload);
              return Promise.resolve({
                data: [{ message_id: key }],
                error: null,
              });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { db, rows, upserts, reads };
}

describe('claimInboundAutoReply', () => {
  it('lets the first caller through and writes the account, responder and automation', async () => {
    const { db, rows, upserts } = fakeDb();

    await expect(
      claimInboundAutoReply(db, {
        accountId: 'acct-1',
        messageId: 'msg-1',
        responder: 'automation',
        automationId: 'auto-9',
      })
    ).resolves.toBe(true);

    expect(rows.get('msg-1')).toEqual({
      message_id: 'msg-1',
      account_id: 'acct-1',
      responder: 'automation',
      automation_id: 'auto-9',
    });
    // The conflict target must be the message, not the (account,
    // message) pair — see migration 051.
    expect(upserts[0].opts).toEqual({
      onConflict: 'message_id',
      ignoreDuplicates: true,
    });
  });

  it('refuses the second caller for the same inbound message', async () => {
    const { db } = fakeDb();
    const first = await claimInboundAutoReply(db, {
      accountId: 'acct-1',
      messageId: 'msg-1',
      responder: 'automation',
    });
    const second = await claimInboundAutoReply(db, {
      accountId: 'acct-1',
      messageId: 'msg-1',
      responder: 'ai',
    });
    expect([first, second]).toEqual([true, false]);
  });

  /**
   * Acceptance criterion 3 — "the customer never receives two automatic
   * replies to the same message" — expressed as the property it really
   * is: N racing responders, exactly one winner.
   */
  it('picks exactly one winner when an automation and the AI race for the same message', async () => {
    const { db, rows } = fakeDb();
    const results = await Promise.all([
      claimInboundAutoReply(db, {
        accountId: 'acct-1',
        messageId: 'msg-1',
        responder: 'automation',
        automationId: 'auto-9',
      }),
      claimInboundAutoReply(db, {
        accountId: 'acct-1',
        messageId: 'msg-1',
        responder: 'ai',
      }),
      claimInboundAutoReply(db, {
        accountId: 'acct-1',
        messageId: 'msg-1',
        responder: 'ai',
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(rows.size).toBe(1);
  });

  it('does not confuse two different inbound messages', async () => {
    const { db } = fakeDb();
    await claimInboundAutoReply(db, {
      accountId: 'acct-1',
      messageId: 'msg-1',
      responder: 'automation',
    });
    await expect(
      claimInboundAutoReply(db, {
        accountId: 'acct-1',
        messageId: 'msg-2',
        responder: 'ai',
      })
    ).resolves.toBe(true);
  });

  it('fails closed (and loudly) when the write errors', async () => {
    const { db } = fakeDb({ error: { message: 'relation does not exist' } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let logged: unknown[][] = [];
    try {
      await expect(
        claimInboundAutoReply(db, {
          accountId: 'acct-1',
          messageId: 'msg-1',
          responder: 'ai',
        })
      ).resolves.toBe(false);
      logged = errorSpy.mock.calls;
    } finally {
      errorSpy.mockRestore();
    }
    expect(logged.flat().join(' ')).toContain('could not reserve the reply');
  });
});

/**
 * The engine honours the reservation (fase 1, §4), so it needs to tell
 * "somebody else answered" from "I answered, and I am still talking".
 */
describe('claimInboundAutoReplyForAutomation', () => {
  const args = {
    accountId: 'acct-1',
    messageId: 'msg-1',
    responder: 'automation' as const,
    automationId: 'auto-9',
  };

  it('wins a free inbound', async () => {
    const { db } = fakeDb();
    await expect(claimInboundAutoReplyForAutomation(db, args)).resolves.toBe(
      true
    );
  });

  it('keeps talking when the reservation is its own', async () => {
    // A run whose steps send twice, or the tail of one resumed after a
    // `wait`: the insert conflicts with the row this same automation
    // wrote, and standing down there would swallow its own messages.
    const { db, reads } = fakeDb();
    await claimInboundAutoReplyForAutomation(db, args);
    await expect(claimInboundAutoReplyForAutomation(db, args)).resolves.toBe(
      true
    );
    expect(reads).toEqual([{ message_id: 'msg-1', account_id: 'acct-1' }]);
  });

  it('stands down when the AI got there first', async () => {
    const { db } = fakeDb();
    await claimInboundAutoReply(db, {
      accountId: 'acct-1',
      messageId: 'msg-1',
      responder: 'ai',
    });
    await expect(claimInboundAutoReplyForAutomation(db, args)).resolves.toBe(
      false
    );
  });

  it('stands down when a different automation got there first', async () => {
    const { db } = fakeDb();
    await claimInboundAutoReplyForAutomation(db, {
      ...args,
      automationId: 'auto-1',
    });
    await expect(claimInboundAutoReplyForAutomation(db, args)).resolves.toBe(
      false
    );
  });

  it('does not accept a reservation belonging to another account', async () => {
    const { db } = fakeDb();
    await claimInboundAutoReplyForAutomation(db, {
      ...args,
      accountId: 'acct-2',
    });
    await expect(claimInboundAutoReplyForAutomation(db, args)).resolves.toBe(
      false
    );
  });

  it('fails closed (and loudly) when the holder cannot be read', async () => {
    const { db } = fakeDb({ readError: { message: 'timeout' } });
    await claimInboundAutoReply(db, {
      accountId: 'acct-1',
      messageId: 'msg-1',
      responder: 'ai',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let logged: unknown[][] = [];
    try {
      await expect(claimInboundAutoReplyForAutomation(db, args)).resolves.toBe(
        false
      );
      logged = errorSpy.mock.calls;
    } finally {
      errorSpy.mockRestore();
    }
    expect(logged.flat().join(' ')).toContain('could not read the holder');
  });
});
