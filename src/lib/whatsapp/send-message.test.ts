import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Fase 3 §4: the send core now charges `messages_out`. Only the two
// DB-touching entry points are stubbed — `importOriginal` keeps
// `QuotaExceededError` real so the tests below assert against the
// genuine class the routes catch.
const billing = vi.hoisted(() => ({
  assertQuota: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertQuota: billing.assertQuota,
  recordUsage: billing.recordUsage,
}));

import { QuotaExceededError } from '@/lib/billing/enforce';
import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

beforeEach(() => {
  billing.assertQuota.mockReset();
  billing.assertQuota.mockResolvedValue(undefined);
  billing.recordUsage.mockReset();
  billing.recordUsage.mockResolvedValue(undefined);
});

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

// ============================================================
// Full send path — what actually lands in `messages` (issue #483).
// ============================================================

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }));
const sendTextMessage = vi.fn(
  async (_args: { phoneNumberId: string; accessToken: string }) => ({
    messageId: 'wamid.text',
  })
);

// Stub only the senders — the module also exports INTERACTIVE_LIMITS,
// which `interactive.ts` needs for the payload validation covered above.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: (...args: unknown[]) =>
    (sendTextMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  // Only used for the best-effort "pause active flow run" write.
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    }),
  }),
}));

interface CapturedWrites {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
}

/**
 * Supabase fake covering the tables the send path touches. Each table
 * gets a builder that is both chainable and awaitable, so the same
 * object serves `.single()` lookups and the bare `select().eq().eq()`
 * the template resolver uses.
 */
function sendPathDb(
  templateRows: unknown[],
  captured: CapturedWrites
): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact: { id: 'ct-1', phone: '+15551234567' },
  };
  const config = {
    id: 'cfg-1',
    phone_number_id: 'pn-1',
    access_token: 'token',
  };

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        // Post-053 the sender number is resolved by `resolve-config.ts`:
        // conversation → its `whatsapp_config_id` → that row. Both legs
        // land on `maybeSingle`, so it has to be table-aware now.
        maybeSingle: async () => {
          if (table === 'conversations') {
            return { data: { whatsapp_config_id: 'cfg-1' }, error: null };
          }
          if (table === 'whatsapp_config') return { data: config, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'whatsapp_config') return { data: config, error: null };
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
        // Bare-await result — only message_templates is read this way.
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data: table === 'message_templates' ? templateRows : [],
            error: null,
          }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const TEMPLATE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessageToConversation — template persistence (#483)', () => {
  it('stores the substituted body when the caller sends no text', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    expect(result.whatsappMessageId).toBe('wamid.1');
    // Was NULL before the fix — the Inbox rendered an empty bubble.
    expect(captured.message?.content_text).toBe(
      'Your order A123 ships on Friday'
    );
    expect(captured.message?.template_name).toBe('order_update');
    // …and the conversation-list preview reads the body, not '[template]'.
    expect(captured.conversation?.last_message_text).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it('reads body values out of the structured params shape too', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateMessageParams: { body: ['B456', 'Monday'] },
      }
    );
    expect(captured.message?.content_text).toBe(
      'Your order B456 ships on Monday'
    );
  });

  it("does not override the composer's pre-rendered text", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
        contentText: 'rendered by the composer',
      }
    );
    expect(captured.message?.content_text).toBe('rendered by the composer');
  });

  it("sends the local row's language when the caller names none", async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );
    // Previously pinned to 'en_US', which matched no row and made Meta
    // reject the send as a missing translation.
    expect(
      (
        sendTemplateMessage.mock.calls[0] as unknown as [{ language: string }]
      )[0].language
    ).toBe('en');
  });

  it('leaves content_text null when the account has no local template row', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'never_synced',
      templateParams: ['A123'],
    });
    // Nothing to render from — the bubble falls back to the template
    // name rather than inventing a body.
    expect(captured.message?.content_text).toBeNull();
    expect(captured.conversation?.last_message_text).toBe('[template]');
  });
});

// ============================================================
// Fase 3 §4 — `messages_out`.
//
// The core is shared by `/api/whatsapp/send` (dashboard) and
// `/api/v1/messages` (public API), so charging it here is what makes
// the cap apply to both. Checked before Meta, counted after the row
// lands.
// ============================================================
describe('sendMessageToConversation — messages_out (fase 3 §4)', () => {
  const textParams: SendMessageParams = {
    conversationId: 'cv-1',
    messageType: 'text',
    contentText: 'hello',
  };

  it('checks the quota for this account before anything is sent', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb([], captured),
      'acct-9',
      textParams
    );
    expect(billing.assertQuota).toHaveBeenCalledWith(
      'acct-9',
      'messages_out',
      1
    );
  });

  it('refuses the send when the monthly allowance is spent — Meta is never called', async () => {
    const captured: CapturedWrites = {};
    billing.assertQuota.mockRejectedValue(
      new QuotaExceededError('messages_out', 3000, 3000)
    );
    await expect(
      sendMessageToConversation(sendPathDb([], captured), 'acct-1', textParams)
    ).rejects.toBeInstanceOf(QuotaExceededError);
    // Nothing reached Meta and nothing was persisted: an over-quota
    // message that already arrived cannot be un-sent.
    expect(captured.message).toBeUndefined();
    expect(billing.recordUsage).not.toHaveBeenCalled();
  });

  it('counts one outbound message only after the row is persisted', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb([], captured),
      'acct-1',
      textParams
    );
    expect(captured.message).toBeDefined();
    expect(billing.recordUsage).toHaveBeenCalledWith(
      'acct-1',
      'messages_out',
      1
    );
    expect(billing.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('does not count a send that failed to persist', async () => {
    const captured: CapturedWrites = {};
    const db = sendPathDb([], captured);
    const original = db.from.bind(db);
    // The message INSERT comes back with an error — the send reached
    // Meta but the row did not land, and the core throws.
    db.from = ((table: string) => {
      const builder = original(table) as unknown as Record<string, unknown>;
      if (table === 'messages') {
        builder.single = async () => ({
          data: null,
          error: { message: 'insert exploded' },
        });
      }
      return builder;
    }) as unknown as typeof db.from;

    await expect(
      sendMessageToConversation(db, 'acct-1', textParams)
    ).rejects.toBeInstanceOf(SendMessageError);
    expect(billing.recordUsage).not.toHaveBeenCalled();
  });
});

// ============================================================
// Fase 4 §1 (criterio 4, fila 4b del plan) — varios números.
//
// The account has two. What decides which one a message leaves through
// is the conversation it belongs to, unless the caller names one. Both
// used to be impossible: the old `.single()` on `account_id` raised
// PGRST116 the moment a second row existed, so this file's whole point
// is that the second row is now normal.
// ============================================================

/**
 * Two-number account. `whatsapp_config` returns whichever row is asked
 * for by id, and the conversation is sealed onto `cfg-support`.
 */
function multiNumberDb(captured: CapturedWrites): SupabaseClient {
  const configs: Record<string, Record<string, unknown>> = {
    'cfg-sales': {
      id: 'cfg-sales',
      account_id: 'acct-1',
      phone_number_id: 'pn-sales',
      access_token: 'tok-sales',
      is_default: true,
    },
    'cfg-support': {
      id: 'cfg-support',
      account_id: 'acct-1',
      phone_number_id: 'pn-support',
      access_token: 'tok-support',
      is_default: false,
    },
  };

  return {
    from(table: string) {
      let askedId: string | null = null;
      let askedDefault = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          if (table === 'whatsapp_config' && col === 'id') {
            askedId = val as string;
          }
          if (table === 'whatsapp_config' && col === 'is_default') {
            askedDefault = true;
          }
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'conversations') {
            return { data: { whatsapp_config_id: 'cfg-support' }, error: null };
          }
          if (table === 'whatsapp_config') {
            if (askedId) return { data: configs[askedId] ?? null, error: null };
            if (askedDefault) {
              return { data: configs['cfg-sales'], error: null };
            }
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'conversations') {
            return {
              data: {
                id: 'cv-1',
                contact: { id: 'ct-1', phone: '+15551234567' },
              },
              error: null,
            };
          }
          if (table === 'messages')
            return { data: { id: 'msg-1' }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: [], error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('sendMessageToConversation — several numbers (fase 4 §1)', () => {
  beforeEach(() => {
    sendTextMessage.mockClear();
  });

  it("sends through the conversation's own number, not the account default", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(multiNumberDb(captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hello',
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0]).toMatchObject({
      phoneNumberId: 'pn-support',
      accessToken: 'tok-support',
    });
  });

  it('sends through the number the caller named, when it names one', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(multiNumberDb(captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hello',
      // The "contact → send template" path and the public API's `from`.
      whatsAppConfigId: 'cfg-sales',
    });

    expect(sendTextMessage.mock.calls[0][0]).toMatchObject({
      phoneNumberId: 'pn-sales',
      accessToken: 'tok-sales',
    });
  });

  it("a number that is not this account's is a 404, and nothing is sent", async () => {
    const captured: CapturedWrites = {};
    const err = await sendMessageToConversation(
      multiNumberDb(captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'hello',
        whatsAppConfigId: 'cfg-of-another-account',
      }
    ).catch((e) => e);

    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.status).toBe(404);
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });
});
