import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 — `messages_out` on the automations sender.
//
// Same gate as the flows sender and the dashboard route. This engine is
// the one most likely to run away: an automation wired to
// `new_message_received` sends on every inbound.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  assertQuota: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  state: { inserts: [] as Record<string, unknown>[] },
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
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.tpl' })),
}));

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: async () => ({
    row: null,
    language: 'en_US',
    malformed: false,
  }),
  templateContentText: () => null,
}));

vi.mock('@/lib/flows/meta-send', () => ({
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
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
          return Promise.resolve({ error: null });
        },
        maybeSingle: async () =>
          table === 'contacts'
            ? { data: { id: 'ct-1', phone: '+15551234567' }, error: null }
            : { data: null, error: null },
        single: async () =>
          table === 'whatsapp_config'
            ? {
                data: { phone_number_id: 'pn-1', access_token: 'token' },
                error: null,
              }
            : { data: null, error: null },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: null }),
      };
      return chain;
    },
  }),
}));

import { QuotaExceededError } from '@/lib/billing/enforce';
import { engineSendText } from './meta-send';

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'ct-1',
  text: 'hi',
};

beforeEach(() => {
  h.state.inserts = [];
  h.assertQuota.mockReset();
  h.assertQuota.mockResolvedValue(undefined);
  h.recordUsage.mockReset();
  h.recordUsage.mockResolvedValue(undefined);
  h.sendTextMessage.mockReset();
  h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' });
});

describe('automations engineSendText — messages_out (fase 3 §4)', () => {
  it('checks the quota before Meta and counts after the row lands', async () => {
    await engineSendText(ARGS);
    expect(h.assertQuota).toHaveBeenCalledWith('acct-1', 'messages_out', 1);
    expect(h.state.inserts).toHaveLength(1);
    expect(h.recordUsage).toHaveBeenCalledWith('acct-1', 'messages_out', 1);
  });

  it('stops the automation at the limit without texting the customer', async () => {
    h.assertQuota.mockRejectedValue(
      new QuotaExceededError('messages_out', 3000, 3000)
    );
    await expect(engineSendText(ARGS)).rejects.toBeInstanceOf(
      QuotaExceededError
    );
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('charges the account of the automation, not a fixed one (leak test)', async () => {
    await engineSendText({ ...ARGS, accountId: 'acct-other' });
    expect(h.assertQuota).toHaveBeenCalledWith('acct-other', 'messages_out', 1);
    expect(h.recordUsage).toHaveBeenCalledWith('acct-other', 'messages_out', 1);
  });
});
