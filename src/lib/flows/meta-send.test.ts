import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 — `messages_out` in the engine senders.
//
// The spec names `engineSendText` next to `/api/whatsapp/send`, and the
// reason is the same for both: an automation or flow firing in a loop is
// the fastest way through a monthly allowance. The cap is checked before
// Meta is called and charged after the row lands, so a send that never
// happened is never billed.
//
// The interactive and media senders carry the same gate: leaving them
// out would turn the cap into a suggestion (send a button message
// instead of a text and it is free).
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  assertQuota: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  state: {
    messageInsertError: null as { message: string } | null,
    inserts: [] as Record<string, unknown>[],
  },
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertQuota: h.assertQuota,
  recordUsage: h.recordUsage,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: (...a: unknown[]) =>
    (h.sendTextMessage as unknown as (...x: unknown[]) => unknown)(...a),
  sendMediaMessage: (...a: unknown[]) =>
    (h.sendMediaMessage as unknown as (...x: unknown[]) => unknown)(...a),
  sendInteractiveButtons: (...a: unknown[]) =>
    (h.sendInteractiveButtons as unknown as (...x: unknown[]) => unknown)(...a),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        update: () => chain,
        insert: (row: Record<string, unknown>) => {
          h.state.inserts.push(row);
          return Promise.resolve({ error: h.state.messageInsertError });
        },
        maybeSingle: async () => {
          if (table === 'contacts') {
            return { data: { id: 'ct-1', phone: '+15551234567' }, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'whatsapp_config') {
            return {
              data: { phone_number_id: 'pn-1', access_token: 'token' },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: null }),
      };
      return chain;
    },
  }),
}));

import { QuotaExceededError } from '@/lib/billing/enforce';
import {
  engineSendText,
  engineSendMedia,
  engineSendInteractiveButtons,
} from './meta-send';

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'ct-1',
};

beforeEach(() => {
  h.state.messageInsertError = null;
  h.state.inserts = [];
  h.assertQuota.mockReset();
  h.assertQuota.mockResolvedValue(undefined);
  h.recordUsage.mockReset();
  h.recordUsage.mockResolvedValue(undefined);
  h.sendTextMessage.mockReset();
  h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' });
  h.sendMediaMessage.mockReset();
  h.sendMediaMessage.mockResolvedValue({ messageId: 'wamid.media' });
  h.sendInteractiveButtons.mockReset();
  h.sendInteractiveButtons.mockResolvedValue({ messageId: 'wamid.btn' });
});

describe('engineSendText — messages_out (fase 3 §4)', () => {
  it('checks the quota for the sending account before Meta is called', async () => {
    await engineSendText({ ...ARGS, text: 'hi' });
    expect(h.assertQuota).toHaveBeenCalledWith('acct-1', 'messages_out', 1);
  });

  it('refuses over the limit, and nothing reaches Meta or the database', async () => {
    h.assertQuota.mockRejectedValue(
      new QuotaExceededError('messages_out', 15000, 15000)
    );
    await expect(
      engineSendText({ ...ARGS, text: 'hi' })
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(h.state.inserts).toHaveLength(0);
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('counts one message after the row is persisted', async () => {
    await engineSendText({ ...ARGS, text: 'hi' });
    expect(h.state.inserts).toHaveLength(1);
    expect(h.recordUsage).toHaveBeenCalledWith('acct-1', 'messages_out', 1);
  });

  it('does not count a send whose row failed to persist', async () => {
    h.state.messageInsertError = { message: 'insert exploded' };
    await expect(engineSendText({ ...ARGS, text: 'hi' })).rejects.toThrow(
      /DB insert failed/
    );
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('charges the account it was told to send for (leak test)', async () => {
    await engineSendText({ ...ARGS, accountId: 'acct-other', text: 'hi' });
    expect(h.assertQuota).toHaveBeenCalledWith('acct-other', 'messages_out', 1);
    expect(h.recordUsage).toHaveBeenCalledWith('acct-other', 'messages_out', 1);
  });
});

describe('the other engine senders carry the same gate', () => {
  it('engineSendMedia checks and counts', async () => {
    await engineSendMedia({
      ...ARGS,
      kind: 'image',
      link: 'https://x/y.jpg',
    });
    expect(h.assertQuota).toHaveBeenCalledWith('acct-1', 'messages_out', 1);
    expect(h.recordUsage).toHaveBeenCalledWith('acct-1', 'messages_out', 1);
  });

  it('engineSendInteractiveButtons checks and counts', async () => {
    await engineSendInteractiveButtons({
      ...ARGS,
      bodyText: 'Pick one',
      buttons: [{ id: 'a', title: 'A' }],
    });
    expect(h.assertQuota).toHaveBeenCalledWith('acct-1', 'messages_out', 1);
    expect(h.recordUsage).toHaveBeenCalledWith('acct-1', 'messages_out', 1);
  });

  it('a blocked interactive send never reaches Meta', async () => {
    h.assertQuota.mockRejectedValue(
      new QuotaExceededError('messages_out', 3000, 3000)
    );
    await expect(
      engineSendInteractiveButtons({
        ...ARGS,
        bodyText: 'Pick one',
        buttons: [{ id: 'a', title: 'A' }],
      })
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(h.sendInteractiveButtons).not.toHaveBeenCalled();
  });
});
