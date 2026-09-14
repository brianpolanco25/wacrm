import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to. A genuine insert
    // returns the row; a replayed delivery conflicts and returns [].
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    /** Row `lookupInternalIdByMetaId` resolves for a `context.id`. */
    replyContextParent: null as { id: string } | null,
    conversation: {
      id: 'conv-1',
      unread_count: 0,
      account_id: 'acc-1',
      // The number this thread runs on (migration 053).
      whatsapp_config_id: 'cfg-pn-1',
    },
    /** Updates written to `conversations` — the seal of fase 4 §1. */
    conversationUpdates: [] as Record<string, unknown>[],
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
    /** `automationCompleted` as it stood when the AI dispatch was
     *  called — the ordering of §4, pinned. Null if it never ran. */
    automationsCompletedAtAiDispatch: null as number | null,
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string;
      path: string;
      options: { contentType?: string };
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,
    /** Every `.from(table)` call, so a test can assert a table was NOT read. */
    fromCalls: [] as string[],
    /** Plaintext verify tokens the GET loop "decrypts" from whatsapp_config. */
    configVerifyTokens: ['tenant-verify-token'] as string[],
    /** Every write against whatsapp_config. The GET must never make one. */
    configWrites: [] as string[],
    /** Contacto que `findExistingContact` (teléfono) resuelve. */
    contactByPhone: {
      id: 'contact-1',
      name: 'Ada',
      phone: '15551230000',
    } as Record<string, unknown> | null,
    /** Contacto que `findContactByWaUserId` (BSUID) resuelve. */
    contactByWaUserId: null as Record<string, unknown> | null,
    /** Filas insertadas en `contacts`. */
    contactInserts: [] as Record<string, unknown>[],
    /** Parches escritos en `contacts`, con sus filtros. */
    contactUpdates: [] as {
      values: Record<string, unknown>;
      filters: Record<string, unknown>;
    }[],
    /** Filas que el casado de estados encuentra por `wamid`. */
    statusMessageRows: [] as Record<string, unknown>[],
    /** Filas de `broadcast_recipients` que encuentra por `wamid`. */
    statusRecipientRows: [] as Record<string, unknown>[],
    /** Actualizaciones escritas sobre `broadcast_recipients`. */
    recipientUpdates: [] as {
      values: Record<string, unknown>;
      id: unknown;
    }[],
    /** Actualizaciones escritas sobre `messages` (estado de entrega). */
    messageStatusUpdates: [] as {
      values: Record<string, unknown>;
      ids: unknown;
    }[],
    /** Filters/limits the GET's verify-token query applied. */
    configVerifyQuery: null as {
      notNull: boolean;
      limit: number | null;
    } | null,
  },
}));

// CP11: every billing gate, wired so it explodes if the storing path
// ever touches it. See the describe block at the end of this file.
const billingGates = vi.hoisted(() => ({
  assertWritable: vi.fn(async () => {}),
  assertQuota: vi.fn(async () => {}),
  assertPlanFeature: vi.fn(async () => {}),
  getEntitlements: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertWritable: billingGates.assertWritable,
  assertQuota: billingGates.assertQuota,
  assertPlanFeature: billingGates.assertPlanFeature,
  getEntitlements: billingGates.getEntitlements,
  recordUsage: billingGates.recordUsage,
}));

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      h.state.fromCalls.push(table);
      switch (table) {
        case 'whatsapp_config': {
          // Two chains land here: the POST path's select().eq() by
          // phone_number_id, and the GET verification loop's bare
          // select() over every row. The select result is therefore a
          // promise (the loop awaits it directly) that also carries `eq`.
          // One row per phone_number_id, with a distinct `id`: post-053
          // the webhook seals that id onto the conversation, and two
          // numbers of the SAME account have to be told apart.
          const byPhone = (_col: string, phoneNumberId: string) =>
            Promise.resolve({
              data: [
                {
                  id: `cfg-${phoneNumberId}`,
                  account_id: 'acc-1',
                  user_id: 'user-1',
                  phone_number_id: phoneNumberId,
                  access_token: 'enc',
                  mirror_inbound_media: h.state.mirrorInboundMedia,
                },
              ],
              error: null,
            });
          const all = Promise.resolve({
            data: h.state.configVerifyTokens.map((token, i) => ({
              id: `cfg-${i}`,
              verify_token: `enc:${token}`,
            })),
            error: null,
          });
          // The GET loop's chain post-f4.1:
          // `.select().not('verify_token','is',null).limit(n)`.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const listChain: any = Object.assign(all, { eq: byPhone });
          listChain.not = (column: string) => {
            h.state.configVerifyQuery = {
              notNull: column === 'verify_token',
              limit: h.state.configVerifyQuery?.limit ?? null,
            };
            return listChain;
          };
          listChain.limit = (n: number) => {
            h.state.configVerifyQuery = {
              notNull: h.state.configVerifyQuery?.notNull ?? false,
              limit: n,
            };
            return listChain;
          };
          return {
            select: () => listChain,
            update: () => {
              h.state.configWrites.push('update');
              return { eq: () => Promise.resolve({ error: null }) };
            },
          };
        }
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          // and, post-053, update().eq().eq() to re-seal the number.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [h.state.conversation],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
            update: (row: Record<string, unknown>) => {
              h.state.conversationUpdates.push(row);
              return {
                eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
              };
            },
          };
        case 'contacts':
          // findOrCreateContact: insert().select().single() y el parche
          // update().eq('id').eq('account_id') de `patchContact`.
          return {
            insert: (row: Record<string, unknown>) => {
              h.state.contactInserts.push(row);
              return {
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: { id: 'contact-new', ...row },
                      error: null,
                    }),
                }),
              };
            },
            update: (values: Record<string, unknown>) => {
              const filters: Record<string, unknown> = {};
              const chain = {
                eq: (column: string, value: unknown) => {
                  filters[column] = value;
                  return chain;
                },
                then: (resolve: (r: unknown) => unknown) =>
                  resolve({ error: null }),
              };
              h.state.contactUpdates.push({ values, filters });
              return chain;
            },
          };
        case 'broadcast_recipients': {
          // Dos cadenas: flagBroadcastReplyIfAny
          // (select().eq().eq().in().order().limit()) y el casado de
          // estados (select().eq().eq() sobre el wamid + la cuenta).
          const statusChain: Record<string, unknown> = {};
          const eqStatus = () =>
            Object.assign(
              Promise.resolve({
                data: h.state.statusRecipientRows,
                error: null,
              }),
              { eq: eqStatus, in: inChain }
            );
          const inChain = () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          });
          void statusChain;
          return {
            select: () => ({ eq: eqStatus }),
            update: (values: Record<string, unknown>) => ({
              eq: (_column: string, id: unknown) => {
                h.state.recipientUpdates.push({ values, id });
                return Promise.resolve({ error: null });
              },
            }),
          };
        }
        case 'messages':
          return {
            // Two different chains land here, told apart by the count
            // option: the prior-message count (head request) and the
            // reply-context parent lookup.
            select: (_columns: string, options?: { head?: boolean }) =>
              options?.head
                ? // priorCustomerMsgCount: select('id',{count,head}).eq().eq()
                  {
                    eq: () => ({
                      eq: () =>
                        Promise.resolve({
                          count: h.state.priorCustomerMsgCount,
                          error: null,
                        }),
                    }),
                  }
                : // Dos cadenas sin `head`: lookupInternalIdByMetaId
                  // (…eq().eq().maybeSingle()) y el casado de estados
                  // (…eq().eq() a secas, awaited).
                  {
                    eq: () => ({
                      eq: () =>
                        Object.assign(
                          Promise.resolve({
                            data: h.state.statusMessageRows,
                            error: null,
                          }),
                          {
                            maybeSingle: () =>
                              Promise.resolve({
                                data: h.state.replyContextParent,
                                error: null,
                              }),
                          }
                        ),
                    }),
                  },
            // Espejo del estado de entrega:
            // update({status}).in('id', ids).in('conversation_id', convs)
            update: (values: Record<string, unknown>) => {
              const captured: {
                values: Record<string, unknown>;
                ids: unknown;
              } = { values, ids: null };
              const chain = {
                in: (column: string, ids: unknown) => {
                  if (column === 'id') {
                    captured.ids = ids;
                    h.state.messageStatusUpdates.push(captured);
                  }
                  return chain;
                },
                then: (resolve: (r: unknown) => unknown) =>
                  resolve({ error: null }),
              };
              return chain;
            },
            // Idempotent insert: upsert(...).select('id')
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options });
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              };
            },
          };
        default:
          throw new Error(`unexpected table: ${table}`);
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
    // Service-role Storage, used by the inbound-media mirror (#466).
    storage: {
      from(bucket: string) {
        return {
          upload: (
            path: string,
            _body: unknown,
            options: { contentType?: string }
          ) => {
            h.state.storageUploads.push({ bucket, path, options });
            return Promise.resolve({ error: h.state.storageUploadError });
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        };
      },
    },
  }),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  // The GET loop stores verify tokens as `enc:<plaintext>` in this mock
  // so each config row decrypts to a distinct value.
  decrypt: (v: string) => (v.startsWith('enc:') ? v.slice(4) : 'plain-token'),
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => h.state.contactByPhone),
  findContactByWaUserId: vi.fn(async () => h.state.contactByWaUserId),
  isUniqueViolation: () => false,
}));
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}));
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: () => false,
  handleTemplateWebhookChange: vi.fn(),
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}));
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}));

import { GET, POST } from './route';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
// The real error class: `vi.mock` above keeps everything it does not
// name, so this is the very object the enforcement layer throws.
import { AccountLockedError } from '@/lib/billing/enforce';

const mockGetMediaUrl = vi.mocked(getMediaUrl);
const mockDownloadMedia = vi.mocked(downloadMedia);

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
};

function inboundRequest(
  message: Record<string, unknown> = TEXT_MESSAGE,
  phoneNumberId = 'pn-1'
) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: '15551230000', profile: { name: 'Ada' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request;
}

async function runWebhook(
  message?: Record<string, unknown>,
  phoneNumberId?: string
) {
  const res = await POST(inboundRequest(message, phoneNumberId));
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.messageUpsertResult = [{ id: 'msg-1' }];
  h.state.priorCustomerMsgCount = 0;
  h.state.replyContextParent = null;
  h.state.conversation = {
    id: 'conv-1',
    unread_count: 0,
    account_id: 'acc-1',
    whatsapp_config_id: 'cfg-pn-1',
  };
  h.state.conversationUpdates = [];
  h.state.upsertCalls = [];
  h.state.rpcCalls = [];
  h.state.afterCallbacks = [];
  h.state.automationStarted = 0;
  h.state.automationCompleted = 0;
  h.state.automationsCompletedAtAiDispatch = null;
  h.state.mirrorInboundMedia = true;
  h.state.storageUploads = [];
  h.state.storageUploadError = null;
  h.state.fromCalls = [];
  h.state.contactByPhone = {
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  };
  h.state.contactByWaUserId = null;
  h.state.contactInserts = [];
  h.state.contactUpdates = [];
  h.state.statusMessageRows = [];
  h.state.statusRecipientRows = [];
  h.state.recipientUpdates = [];
  h.state.messageStatusUpdates = [];
  h.state.configVerifyTokens = ['tenant-verify-token'];
  h.state.configWrites = [];
  h.state.configVerifyQuery = null;
  vi.unstubAllEnvs();
  // `unstubAllEnvs` only undoes previous `stubEnv` calls; it does not
  // clear a variable exported in the developer's shell. The self-hosted
  // tests below assert the per-tenant loop runs, which needs the
  // platform token absent, so pin it to the empty string (the route
  // treats that as unset) instead of trusting the ambient environment.
  vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '');
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  });
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  });
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false });
  h.dispatchInboundToAiReply.mockImplementation(async () => {
    h.state.automationsCompletedAtAiDispatch = h.state.automationCompleted;
  });
  h.dispatchWebhookEvent.mockResolvedValue(undefined);
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++;
        resolve();
      }, 0);
    });
  });
});

describe('inbound webhook: idempotent insert (#367)', () => {
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook();

    // Inserted via upsert with the (conversation_id, message_id) conflict
    // target — not a bare insert.
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    });
    // Downstream side effects ran exactly once.
    expect(h.state.rpcCalls).toHaveLength(1);
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1);
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // Upsert hits the unique index and returns no row.
    h.state.messageUpsertResult = [];

    await runWebhook();

    expect(h.state.upsertCalls).toHaveLength(1);
    // None of the downstream side effects fire on a replay.
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('increments unread through the DB-side RPC, not a read-modify-write', async () => {
    await runWebhook();

    expect(h.state.rpcCalls).toHaveLength(1);
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'bump_conversation_on_inbound',
      args: { p_conversation_id: 'conv-1' },
    });
  });
});

describe('inbound webhook: template quick-reply buttons (#478)', () => {
  // A customer tapping a QUICK_REPLY button on a broadcast template.
  // `context.id` points at the template message we sent — which the
  // broadcast path never wrote to `messages`, so the parent lookup
  // legitimately misses and the reply is stored unquoted.
  const templateButtonTap = {
    id: 'wamid.BTN1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  };

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(templateButtonTap);

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes, interested',
      interactive_reply_id: 'YES_INTERESTED',
      reply_to_message_id: null,
    });
  });

  it('routes the tap to flows and fires the interactive_reply trigger', async () => {
    await runWebhook(templateButtonTap);

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'YES_INTERESTED',
          reply_title: 'Yes, interested',
          meta_message_id: 'wamid.BTN1',
        },
      })
    );
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType
    );
    expect(triggers).toContain('interactive_reply');
    // The AI auto-reply must stay out of it — a button tap is not a
    // free-text question.
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
  });

  it('falls back to the label when the template button carries no payload', async () => {
    await runWebhook({
      ...templateButtonTap,
      button: { text: 'Track my order' },
    });

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Track my order',
      interactive_reply_id: 'Track my order',
    });
  });
});

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
  };

  it('stores a durable bucket URL instead of the expiring proxy path', async () => {
    await runWebhook(IMAGE_MESSAGE);

    expect(h.state.storageUploads).toHaveLength(1);
    expect(h.state.storageUploads[0].bucket).toBe('chat-media');
    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-image-1700000000.jpg'
    );
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        'https://cdn.test/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
      // Meta's MIME type used to be discarded outright (`void mediaType`).
      media_type: 'image/jpeg',
    });
  });

  it('falls back to the proxy URL when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' };

    await runWebhook(IMAGE_MESSAGE);

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      media_type: 'image/jpeg',
    });
  });

  it('falls back to the proxy URL when the download from Meta throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(
      new Error('Media download failed: 404')
    );

    await runWebhook(IMAGE_MESSAGE);

    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
    });
  });

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/big',
      mimeType: 'application/pdf',
      fileSize: 40 * 1024 * 1024,
    });

    await runWebhook({
      id: 'wamid.DOC1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        filename: 'huge.pdf',
      },
    });

    expect(mockDownloadMedia).not.toHaveBeenCalled();
    expect(h.state.storageUploads).toHaveLength(0);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/999',
      media_type: 'application/pdf',
    });
  });

  it("names the object after a document's own filename", async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/doc',
      mimeType: 'application/pdf',
      fileSize: 4096,
    });
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    });

    await runWebhook({
      id: 'wamid.DOC2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'have a look',
      },
    });

    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-invoice.pdf'
    );
  });

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false;

    await runWebhook(IMAGE_MESSAGE);

    expect(mockDownloadMedia).not.toHaveBeenCalled();
    expect(h.state.storageUploads).toHaveLength(0);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for proxied media.
      media_type: 'image/jpeg',
    });
  });

  it('mirrors when the column is absent, e.g. a row read before migration 039', async () => {
    h.state.mirrorInboundMedia = undefined;

    await runWebhook(IMAGE_MESSAGE);

    expect(h.state.storageUploads).toHaveLength(1);
  });

  it('leaves text messages alone', async () => {
    await runWebhook();

    expect(mockGetMediaUrl).not.toHaveBeenCalled();
    expect(h.state.storageUploads).toHaveLength(0);
    expect(h.state.upsertCalls[0].row).toMatchObject({ media_type: null });
  });
});

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook();

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3);
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3);
  });
});

describe('inbound webhook: automations run before the AI (fase 1, §4)', () => {
  it('dispatches AND awaits every automation before dispatchInboundToAiReply', async () => {
    await runWebhook();

    // The reservation makes a double reply impossible either way, but the
    // order decides who usually answers: if the AI asked first, a keyword
    // automation that was still running would lose its own message. Swap
    // the two calls in processMessage, or drop the `await` on the
    // automation loop, and this drops to 0.
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(1);
    expect(h.state.automationsCompletedAtAiDispatch).toBe(3);
  });

  it('hands the AI the inbound id the automations were given, so both reserve the same row', async () => {
    await runWebhook();

    const automationContexts = h.runAutomationsForTrigger.mock.calls.map(
      ([input]) => (input as { context: Record<string, unknown> }).context
    );
    expect(automationContexts).toHaveLength(3);
    for (const context of automationContexts) {
      expect(context.inbound_message_id).toBe('msg-1');
    }
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ inboundMessageId: 'msg-1' })
    );
  });
});

describe('webhook GET verification: platform token short path', () => {
  function verifyRequest(token: string) {
    const url = new URL('https://crm.example/api/whatsapp/webhook');
    url.searchParams.set('hub.mode', 'subscribe');
    url.searchParams.set('hub.challenge', 'challenge-123');
    url.searchParams.set('hub.verify_token', token);
    return { url: url.toString() } as unknown as Request;
  }

  it('with META_WEBHOOK_VERIFY_TOKEN set, a matching token echoes the challenge without touching whatsapp_config', async () => {
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'platform-secret');

    const res = (await GET(verifyRequest('platform-secret'))) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('challenge-123');
    expect(h.state.fromCalls).not.toContain('whatsapp_config');
  });

  it('with META_WEBHOOK_VERIFY_TOKEN set, a tenant token that only exists in whatsapp_config is refused', async () => {
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'platform-secret');

    // Would match a config row — but in platform mode the table is not
    // consulted, so the per-tenant token is no longer a valid credential.
    const res = (await GET(verifyRequest('tenant-verify-token'))) as {
      init?: { status?: number };
    };
    expect(res.init?.status).toBe(403);
    expect(h.state.fromCalls).not.toContain('whatsapp_config');
  });

  it('without META_WEBHOOK_VERIFY_TOKEN, the per-tenant loop is intact: a config token matches', async () => {
    h.state.configVerifyTokens = ['other-tenant', 'tenant-verify-token'];

    const res = (await GET(verifyRequest('tenant-verify-token'))) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('challenge-123');
    expect(h.state.fromCalls).toContain('whatsapp_config');
  });

  it('without META_WEBHOOK_VERIFY_TOKEN, an unknown token is a 403 after consulting the table', async () => {
    const res = (await GET(verifyRequest('nobody-has-this'))) as {
      init?: { status?: number };
    };
    expect(res.init?.status).toBe(403);
    expect(h.state.fromCalls).toContain('whatsapp_config');
  });

  it('an empty META_WEBHOOK_VERIFY_TOKEN counts as unset', async () => {
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '');

    const res = (await GET(verifyRequest('tenant-verify-token'))) as Response;
    expect(res.status).toBe(200);
    expect(h.state.fromCalls).toContain('whatsapp_config');
  });

  it('surrounding whitespace in META_WEBHOOK_VERIFY_TOKEN is trimmed, not part of the token', async () => {
    // A secret file or a hand-edited .env line leaves a trailing
    // newline. Untrimmed, the short path activates and never matches:
    // every subscribe 403s.
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', ' platform-secret\n');

    const res = (await GET(verifyRequest('platform-secret'))) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('challenge-123');
    expect(h.state.fromCalls).not.toContain('whatsapp_config');
  });

  it('a whitespace-only META_WEBHOOK_VERIFY_TOKEN counts as unset', async () => {
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '   ');

    const res = (await GET(verifyRequest('tenant-verify-token'))) as Response;
    expect(res.status).toBe(200);
    expect(h.state.fromCalls).toContain('whatsapp_config');
  });

  // ------------------------------------------------------------
  // Fase 4 §1 (§5 of the design note): the self-hosted loop stays, the
  // write inside it does not.
  //
  // The old version re-encrypted a legacy CBC verify token to GCM on
  // the way past — a database UPDATE triggered by an unauthenticated
  // GET, reachable by anyone who guesses a verify token. The versioned
  // decrypt of f2.3 reads the legacy format unaided, so the write bought
  // nothing and cost an unauthenticated write path.
  // ------------------------------------------------------------
  it('the per-tenant loop verifies without writing anything back', async () => {
    h.state.configVerifyTokens = ['tenant-verify-token'];

    const res = (await GET(verifyRequest('tenant-verify-token'))) as Response;

    expect(res.status).toBe(200);
    expect(h.state.fromCalls).toContain('whatsapp_config');
    // The point of the test: zero writes on an unauthenticated GET.
    expect(h.state.configWrites).toEqual([]);
  });

  it('a mismatching token writes nothing either', async () => {
    await GET(verifyRequest('nobody-has-this'));
    expect(h.state.configWrites).toEqual([]);
  });

  it('the scan skips rows without a verify token and is bounded', async () => {
    // Platform signup writes `verify_token = NULL`, so in a mixed
    // deployment those rows are dead weight in this query; the limit is
    // the ceiling that keeps a subscribe from scanning the whole table.
    await GET(verifyRequest('tenant-verify-token'));
    expect(h.state.configVerifyQuery).toEqual({ notNull: true, limit: 200 });
  });

  it('the 403 of the platform path warns without echoing either token', async () => {
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'platform-secret');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = (await GET(verifyRequest('attacker-guess'))) as {
      init?: { status?: number };
    };
    expect(res.init?.status).toBe(403);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0].map(String).join(' ');
    expect(logged).not.toContain('attacker-guess');
    expect(logged).not.toContain('platform-secret');

    warn.mockRestore();
  });
});
// ---------------------------------------------------------------------------
// CP11 / fase 3 §4 — "lo entrante nunca se bloquea".
//
// Every billing gate in the enforcement layer is wired to REFUSE here, as
// a suspended account with every allowance spent would. The inbound
// message must still land: losing a customer's message over an unpaid
// invoice is damage that cannot be repaired, and it would break the
// tenant's relationship with Meta, who is the one actually charging them
// for the conversation.
//
// This is a structural guard as much as a behavioural one: the webhook
// must not consult the billing layer at all on the storing path, so the
// day someone adds an `assertWritable` to it, this test goes red.
// ---------------------------------------------------------------------------
describe('inbound webhook: billing never blocks what comes in (CP11)', () => {
  beforeEach(() => {
    billingGates.assertWritable.mockRejectedValue(
      new Error('billing said no — and it must not be asked')
    );
    billingGates.assertQuota.mockRejectedValue(
      new Error('billing said no — and it must not be asked')
    );
    billingGates.getEntitlements.mockRejectedValue(
      new Error('billing said no — and it must not be asked')
    );
  });

  it('stores the inbound message with the subscription suspended and every quota spent', async () => {
    await runWebhook();

    // The message is on record…
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'customer',
    });
    // …and the conversation was bumped so a human sees it in the inbox.
    expect(h.state.rpcCalls).toHaveLength(1);
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'bump_conversation_on_inbound',
    });
  });

  it('stores it while a PLATFORM OPERATOR holds the account suspended (fase 4 §2)', async () => {
    // The manual hold of migration 058 is a read-only lock like any
    // other, and CP11 does not bend for it either: cutting a customer
    // off from sending must never lose the messages their own customers
    // send them. The gate is wired to refuse with the exact error a hold
    // produces.
    billingGates.assertWritable.mockRejectedValue(
      new AccountLockedError('active', true)
    );

    await runWebhook();

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'customer',
    });
    expect(billingGates.assertWritable).not.toHaveBeenCalled();
  });

  it('never asks the billing layer anything while storing an inbound', async () => {
    await runWebhook();

    expect(billingGates.assertWritable).not.toHaveBeenCalled();
    expect(billingGates.assertQuota).not.toHaveBeenCalled();
    expect(billingGates.getEntitlements).not.toHaveBeenCalled();
  });

  // The ENGINES do ask (fase 3 §5: a suspended account's flows and
  // automations stop replying — src/lib/{flows,automations}/meta-send.ts).
  // What must hold is the order: by the time either of them can refuse,
  // the customer's message is already on record.
  it('stores the inbound before either outbound engine is asked anything', async () => {
    const storedWhenAsked: number[] = [];
    h.dispatchInboundToFlows.mockImplementation(async () => {
      storedWhenAsked.push(h.state.upsertCalls.length);
      // What a refused flow returns: the runner logged a failed step
      // and swallowed it.
      return { consumed: false, outcome: 'no_match' };
    });
    h.runAutomationsForTrigger.mockImplementation(async () => {
      storedWhenAsked.push(h.state.upsertCalls.length);
    });

    await runWebhook();

    expect(storedWhenAsked.length).toBeGreaterThan(0);
    // Not "a message exists by the end" — one already existed at each
    // engine's entry.
    expect(storedWhenAsked.every((n) => n === 1)).toBe(true);
  });
});

// ============================================================
// Fase 4 §1 (criterio 4, fila 4d del plan) — «recibe correctamente en
// todos». One account, two numbers: both inbounds are stored, and the
// thread remembers the number the customer wrote to LAST, which is the
// one the reply has to leave through.
//
// The (account_id, contact_id) unique index of migration 036 stays: a
// contact who writes to two of a company's numbers still has ONE
// conversation. What changes is which number that conversation runs on.
// ============================================================

describe('inbound webhook: several numbers per account (fase 4 §1)', () => {
  it('stores messages arriving on either number of the same account', async () => {
    await runWebhook(undefined, 'pn-sales');
    await runWebhook({ ...TEXT_MESSAGE, id: 'wamid.2' }, 'pn-support');

    const stored = h.state.upsertCalls.map((c) => c.row.message_id);
    expect(stored).toContain(TEXT_MESSAGE.id);
    expect(stored).toContain('wamid.2');
    // Both land in the same account's single conversation: the
    // (account_id, contact_id) unique index of 036 is untouched.
    for (const call of h.state.upsertCalls) {
      expect(call.row.conversation_id).toBe('conv-1');
    }
  });

  it('seals the conversation with the number the customer wrote to', async () => {
    // The thread is currently on pn-1; the customer writes to support.
    await runWebhook(undefined, 'pn-support');

    expect(h.state.conversationUpdates).toContainEqual({
      whatsapp_config_id: 'cfg-pn-support',
    });
  });

  it('does not rewrite the seal when the number has not changed', async () => {
    h.state.conversation = {
      id: 'conv-1',
      unread_count: 0,
      account_id: 'acc-1',
      whatsapp_config_id: 'cfg-pn-sales',
    };

    await runWebhook(undefined, 'pn-sales');

    expect(
      h.state.conversationUpdates.filter((u) => 'whatsapp_config_id' in u)
    ).toHaveLength(0);
  });
});

// ============================================================
// BSUID — identidad de WhatsApp sin teléfono (fase 6 §5).
//
// El payload de los casos «sin teléfono» es el que documenta Meta:
// `messages[].from` y `contacts[].wa_id` AUSENTES, `from_user_id` y
// `contacts[].user_id` presentes, y el nombre de usuario en
// `profile.username`.
// ============================================================

/** Un entrante tal y como llega de un usuario con nombre de usuario. */
function bsuidRequest(
  overrides: {
    message?: Record<string, unknown>;
    contact?: Record<string, unknown> | null;
  } = {}
) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts:
                overrides.contact === null
                  ? undefined
                  : [
                      overrides.contact ?? {
                        user_id: 'US.1349700000000001',
                        profile: { name: 'Ada', username: 'ada' },
                      },
                    ],
              messages: [
                overrides.message ?? {
                  id: 'wamid.BSUID1',
                  from_user_id: 'US.1349700000000001',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'hola' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request;
}

async function runBsuidWebhook(overrides?: {
  message?: Record<string, unknown>;
  contact?: Record<string, unknown> | null;
}) {
  const res = await POST(bsuidRequest(overrides));
  for (const cb of h.state.afterCallbacks) await cb();
  return res;
}

describe('inbound webhook: BSUID (fase 6 §5)', () => {
  it('un entrante sin `from` pero con `from_user_id` crea contacto, conversación y mensaje', async () => {
    // Nadie con ese BSUID ni con ese teléfono: es su primer mensaje.
    h.state.contactByPhone = null;
    h.state.contactByWaUserId = null;

    await runBsuidWebhook();

    expect(h.state.contactInserts).toHaveLength(1);
    expect(h.state.contactInserts[0]).toMatchObject({
      account_id: 'acc-1',
      phone: null,
      wa_user_id: 'US.1349700000000001',
      wa_username: 'ada',
      name: 'Ada',
    });
    // Y el mensaje se guarda: lo entrante nunca se bloquea (CP11).
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].row.content_text).toBe('hola');
  });

  it('sin nombre de perfil, el contacto se llama «@usuario»', async () => {
    h.state.contactByPhone = null;
    h.state.contactByWaUserId = null;

    await runBsuidWebhook({
      contact: {
        user_id: 'US.1349700000000001',
        profile: { username: 'ada' },
      },
    });

    expect(h.state.contactInserts[0].name).toBe('@ada');
  });

  it('un contacto que ya existe por teléfono recibe su BSUID sin duplicarse', async () => {
    // La agenda ya tiene a Ada por teléfono, todavía sin BSUID.
    h.state.contactByPhone = {
      id: 'contact-1',
      name: 'Ada',
      phone: '15551230000',
    };
    h.state.contactByWaUserId = null;

    // El webhook trae las dos identidades (Meta manda el teléfono
    // porque seguimos dentro de la ventana de 30 días).
    await runBsuidWebhook({
      message: {
        id: 'wamid.BSUID2',
        from: '15551230000',
        from_user_id: 'US.1349700000000001',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hola' },
      },
      contact: {
        wa_id: '15551230000',
        user_id: 'US.1349700000000001',
        profile: { name: 'Ada', username: 'ada' },
      },
    });

    // Ni un contacto nuevo…
    expect(h.state.contactInserts).toHaveLength(0);
    // …y el BSUID queda escrito en SU fila, acotada por cuenta (CP3).
    expect(h.state.contactUpdates).toHaveLength(1);
    expect(h.state.contactUpdates[0].values).toMatchObject({
      wa_user_id: 'US.1349700000000001',
      wa_username: 'ada',
    });
    expect(h.state.contactUpdates[0].filters).toEqual({
      id: 'contact-1',
      account_id: 'acc-1',
    });
  });

  it('un contacto nacido por BSUID recibe el teléfono cuando Meta lo incluye', async () => {
    h.state.contactByWaUserId = {
      id: 'contact-1',
      name: 'Ada',
      phone: null,
      wa_user_id: 'US.1349700000000001',
      wa_username: 'ada',
    };

    await runBsuidWebhook({
      message: {
        id: 'wamid.BSUID3',
        from: '15551230000',
        from_user_id: 'US.1349700000000001',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'ya te paso mi número' },
      },
      contact: {
        wa_id: '15551230000',
        user_id: 'US.1349700000000001',
        profile: { name: 'Ada', username: 'ada' },
      },
    });

    expect(h.state.contactInserts).toHaveLength(0);
    expect(h.state.contactUpdates).toHaveLength(1);
    expect(h.state.contactUpdates[0].values).toMatchObject({
      phone: '15551230000',
    });
  });

  it('no pisa un teléfono ya guardado con el que trae el webhook', async () => {
    h.state.contactByWaUserId = {
      id: 'contact-1',
      name: 'Ada',
      phone: '15551230000',
      wa_user_id: 'US.1349700000000001',
      wa_username: 'ada',
    };

    await runBsuidWebhook({
      message: {
        id: 'wamid.BSUID4',
        from: '15559999999',
        from_user_id: 'US.1349700000000001',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hola' },
      },
      contact: {
        wa_id: '15559999999',
        user_id: 'US.1349700000000001',
        profile: { name: 'Ada', username: 'ada' },
      },
    });

    expect(h.state.contactUpdates).toHaveLength(0);
  });

  it('el BSUID llega solo en `contacts[].user_id` y basta', async () => {
    h.state.contactByPhone = null;
    h.state.contactByWaUserId = null;

    await runBsuidWebhook({
      message: {
        id: 'wamid.BSUID5',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hola' },
      },
    });

    expect(h.state.contactInserts).toHaveLength(1);
    expect(h.state.contactInserts[0].wa_user_id).toBe('US.1349700000000001');
  });

  it('un mensaje sin ninguna identidad se descarta sin tumbar el resto del lote', async () => {
    h.state.contactByPhone = null;
    h.state.contactByWaUserId = null;

    const body = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1' },
                contacts: [
                  { profile: { name: 'Fantasma' } },
                  {
                    user_id: 'US.1349700000000002',
                    profile: { name: 'Ada', username: 'ada' },
                  },
                ],
                messages: [
                  {
                    id: 'wamid.GHOST',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'sin identidad' },
                  },
                  {
                    id: 'wamid.GOOD',
                    from_user_id: 'US.1349700000000002',
                    timestamp: '1700000001',
                    type: 'text',
                    text: { body: 'con identidad' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const res = await POST({
      text: async () => JSON.stringify(body),
      headers: { get: () => 'sha256=stub' },
    } as unknown as Request);
    for (const cb of h.state.afterCallbacks) await cb();

    expect(
      (res as unknown as { init?: { status?: number } }).init?.status
    ).toBe(200);
    // El ilegible no se guarda; el válido sí. Esto es CP11.
    const stored = h.state.upsertCalls.map((c) => c.row.message_id);
    expect(stored).toEqual(['wamid.GOOD']);
  });
});

describe('estados de entrega: casados por recipient_user_id (fase 6 §5)', () => {
  function statusRequest(status: Record<string, unknown>) {
    const body = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1' },
                statuses: [status],
              },
            },
          ],
        },
      ],
    };
    return {
      text: async () => JSON.stringify(body),
      headers: { get: () => 'sha256=stub' },
    } as unknown as Request;
  }

  async function runStatus(status: Record<string, unknown>) {
    await POST(statusRequest(status));
    for (const cb of h.state.afterCallbacks) await cb();
  }

  it('un estado sin `recipient_id` avanza la fila de difusión igualmente', async () => {
    h.state.statusRecipientRows = [
      { id: 'rcpt-1', status: 'sent', contact_id: 'contact-1' },
    ];

    await runStatus({
      id: 'wamid.OUT1',
      status: 'delivered',
      timestamp: '1700000000',
      recipient_user_id: 'US.1349700000000001',
    });

    expect(h.state.recipientUpdates).toHaveLength(1);
    expect(h.state.recipientUpdates[0].id).toBe('rcpt-1');
    expect(h.state.recipientUpdates[0].values).toMatchObject({
      status: 'delivered',
    });
  });

  it('con varias filas para el mismo wamid, gana la del destinatario del evento', async () => {
    // El BSUID del evento resuelve a `contact-2`.
    h.state.contactByWaUserId = { id: 'contact-2', phone: null };
    h.state.statusRecipientRows = [
      { id: 'rcpt-otro', status: 'sent', contact_id: 'contact-1' },
      { id: 'rcpt-mio', status: 'sent', contact_id: 'contact-2' },
    ];

    await runStatus({
      id: 'wamid.OUT2',
      status: 'read',
      timestamp: '1700000000',
      recipient_user_id: 'US.1349700000000002',
    });

    expect(h.state.recipientUpdates).toHaveLength(1);
    expect(h.state.recipientUpdates[0].id).toBe('rcpt-mio');
  });

  it('el espejo sobre `messages` se acota a las filas de la cuenta', async () => {
    h.state.statusMessageRows = [
      {
        id: 'msg-9',
        conversation_id: 'conv-1',
        conversations: { account_id: 'acc-1', contact_id: 'contact-1' },
      },
    ];

    await runStatus({
      id: 'wamid.OUT3',
      status: 'read',
      timestamp: '1700000000',
      recipient_user_id: 'US.1349700000000001',
    });

    expect(h.state.messageStatusUpdates).toHaveLength(1);
    expect(h.state.messageStatusUpdates[0].ids).toEqual(['msg-9']);
    // Y el evento público sale con la cuenta correcta.
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'message.status_updated',
      expect.objectContaining({ whatsapp_message_id: 'wamid.OUT3' })
    );
  });
});
