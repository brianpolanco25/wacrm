import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDatabase, type Row } from './fake-supabase';
import { encrypt } from '@/lib/whatsapp/encryption';
import { hashApiKey } from '@/lib/api-keys/keys';
import { API_SCOPES } from '@/lib/api-keys/scopes';

// ============================================================
// Tenant-isolation suite.
//
// Every route that runs with the service role bypasses RLS, so the only
// thing standing between two companies is the `.eq('account_id', …)`
// each query carries by hand. This suite seeds two accounts — A and B —
// with parallel data in EVERY table those routes touch, runs each route
// as an actor from A, and asserts three things:
//
//   1. nothing that belongs to B appears in the response;
//   2. addressing B's ids as A yields 404 (never 403, never the row);
//   3. B's rows are byte-for-byte unchanged afterwards.
//
// The database is `fake-supabase.ts`, which evaluates queries for real.
// B's rows are deliberately seeded FIRST in each table and, where the
// data allows it, B carries the same phone number / template name as A,
// so an unscoped `.limit(1)` or `.single()` lands on B — removing an
// `account_id` filter from any covered route fails a test here.
//
// Routes that run under the cookie-session client rely on RLS, which the
// fake simulates from migration 017; they are covered so a switch to the
// admin client without a filter would surface immediately.
// ============================================================

const A = 'acct-a';
const B = 'acct-b';
const USER_A = 'user-a';
const USER_B = 'user-b';
const SHARED_PHONE = '+15551230000';
const KEY_A = 'wacrm_live_keyA_keyA_keyA_keyA_keyA_keyA_keyA';
const KEY_B = 'wacrm_live_keyB_keyB_keyB_keyB_keyB_keyB_keyB';

const h = vi.hoisted(() => ({
  db: null as unknown as import('./fake-supabase').FakeDatabase,
  actor: { userId: 'user-a', accountId: 'acct-a' } as {
    userId: string;
    accountId: string;
  },
  after: [] as (() => Promise<void> | void)[],
  meta: {
    sends: [] as { fn: string; args: Record<string, unknown> }[],
  },
  webhookEvents: [] as { accountId: string; event: string }[],
  ingestedDocuments: [] as string[],
  validatedAiKeys: [] as string[],
}));

// ---- module mocks --------------------------------------------------

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => h.db.asUser(h.actor),
}));

// Every admin client (the three lib modules and the two routes that
// build their own from `@supabase/supabase-js`) resolves to the current
// test's database through one forwarding client.
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const mod = await import('./fake-supabase');
  const forward = mod.forwardingClient(() => h.db.admin);
  return {
    ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
    createClient: () => forward,
  };
});
vi.mock('@/lib/flows/admin-client', async () => {
  const mod = await import('./fake-supabase');
  const forward = mod.forwardingClient(() => h.db.admin);
  return { supabaseAdmin: () => forward };
});
vi.mock('@/lib/automations/admin-client', async () => {
  const mod = await import('./fake-supabase');
  const forward = mod.forwardingClient(() => h.db.admin);
  return { supabaseAdmin: () => forward };
});
vi.mock('@/lib/ai/admin-client', async () => {
  const mod = await import('./fake-supabase');
  const forward = mod.forwardingClient(() => h.db.admin);
  return { supabaseAdmin: () => forward };
});

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (cb: () => Promise<void> | void) => {
    h.after.push(cb);
  },
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({
    success: true,
    limit: 1000,
    remaining: 999,
    reset: Date.now() + 60_000,
  }),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/lib/whatsapp/meta-api')>();
  const record =
    (fn: string, result: unknown) => async (args: Record<string, unknown>) => {
      h.meta.sends.push({ fn, args });
      return result;
    };
  return {
    ...original,
    sendTextMessage: record('sendTextMessage', { messageId: 'wamid.T' }),
    sendTemplateMessage: record('sendTemplateMessage', {
      messageId: 'wamid.TPL',
    }),
    sendMediaMessage: record('sendMediaMessage', { messageId: 'wamid.M' }),
    sendInteractiveButtons: record('sendInteractiveButtons', {
      messageId: 'wamid.B',
    }),
    sendInteractiveList: record('sendInteractiveList', {
      messageId: 'wamid.L',
    }),
    sendReactionMessage: record('sendReactionMessage', {
      messageId: 'wamid.R',
    }),
    uploadMedia: record('uploadMedia', { mediaId: 'MEDIA-1' }),
    getMediaUrl: record('getMediaUrl', {
      url: 'https://lookaside.fbsbx.com/x',
      mimeType: 'image/jpeg',
      fileSize: 10,
    }),
    downloadMedia: record('downloadMedia', {
      buffer: Buffer.alloc(10),
      contentType: 'image/jpeg',
    }),
    verifyPhoneNumber: record('verifyPhoneNumber', {
      id: 'pn-x',
      display_phone_number: '+1 555 000',
    }),
    registerPhoneNumber: record('registerPhoneNumber', {
      success: true,
      alreadyRegistered: false,
    }),
    subscribeWabaToApp: record('subscribeWabaToApp', undefined),
  };
});

vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}));

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: async (
    _db: unknown,
    accountId: string,
    event: string
  ) => {
    h.webhookEvents.push({ accountId, event });
  },
}));

vi.mock('@/lib/ai/generate', () => ({
  generateReply: async () => ({
    text: 'AI says hi',
    handoff: false,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }),
}));
vi.mock('@/lib/ai/knowledge', () => ({
  retrieveKnowledge: async () => [],
  ingestDocument: async (
    _db: unknown,
    _accountId: string,
    _config: unknown,
    documentId: string
  ) => {
    h.ingestedDocuments.push(documentId);
  },
}));
vi.mock('@/lib/ai/validate', () => ({
  validateAiCredentials: async ({ apiKey }: { apiKey: string }) => {
    h.validatedAiKeys.push(apiKey);
  },
}));

// ---- routes under test ---------------------------------------------

import * as v1Me from '@/app/api/v1/me/route';
import * as v1Contacts from '@/app/api/v1/contacts/route';
import * as v1ContactById from '@/app/api/v1/contacts/[id]/route';
import * as v1Conversations from '@/app/api/v1/conversations/route';
import * as v1ConversationById from '@/app/api/v1/conversations/[id]/route';
import * as v1ConversationMessages from '@/app/api/v1/conversations/[id]/messages/route';
import * as v1Messages from '@/app/api/v1/messages/route';
import * as v1Broadcasts from '@/app/api/v1/broadcasts/route';
import * as v1BroadcastById from '@/app/api/v1/broadcasts/[id]/route';
import * as v1Webhooks from '@/app/api/v1/webhooks/route';
import * as v1WebhookById from '@/app/api/v1/webhooks/[id]/route';
import * as waSend from '@/app/api/whatsapp/send/route';
import * as waBroadcast from '@/app/api/whatsapp/broadcast/route';
import * as waBroadcastResume from '@/app/api/whatsapp/broadcast/[id]/resume/route';
import * as waWebhook from '@/app/api/whatsapp/webhook/route';
import * as waConfig from '@/app/api/whatsapp/config/route';
import * as automationsCron from '@/app/api/automations/cron/route';
import * as flowsCron from '@/app/api/flows/cron/route';
import * as automations from '@/app/api/automations/route';
import * as automationById from '@/app/api/automations/[id]/route';
import * as automationDuplicate from '@/app/api/automations/[id]/duplicate/route';
import * as flows from '@/app/api/flows/route';
import * as flowById from '@/app/api/flows/[id]/route';
import * as flowActivate from '@/app/api/flows/[id]/activate/route';
import * as quickReplies from '@/app/api/quick-replies/route';
import * as quickReplyById from '@/app/api/quick-replies/[id]/route';
import * as aiDraft from '@/app/api/ai/draft/route';
import * as aiConfig from '@/app/api/ai/config/route';
import * as aiUsage from '@/app/api/ai/usage/route';
import * as aiAutoreply from '@/app/api/ai/autoreply/[conversationId]/route';
import * as aiKnowledge from '@/app/api/ai/knowledge/route';
import * as aiKnowledgeById from '@/app/api/ai/knowledge/[id]/route';
import * as aiKnowledgeReindex from '@/app/api/ai/knowledge/reindex/route';
import * as aiPlayground from '@/app/api/ai/playground/route';
import * as aiTest from '@/app/api/ai/test/route';

// ---- seed ------------------------------------------------------------

const PAST = '2026-01-01T00:00:00.000Z';
const OLDER = '2025-12-31T00:00:00.000Z';

/**
 * Two parallel accounts. B is seeded first in every table on purpose,
 * and shares the customer phone number and the template name with A, so
 * an unscoped lookup lands on B's row.
 */
function seed(): FakeDatabase {
  const perAccount = (acct: string, user: string, tag: string) => {
    const created = acct === B ? OLDER : PAST;
    return {
      account: { id: acct, name: `Company ${tag}`, owner_user_id: user },
      profile: {
        id: `profile-${tag}`,
        user_id: user,
        account_id: acct,
        account_role: 'owner',
        full_name: `Owner ${tag}`,
      },
      config: {
        id: `cfg-${tag}`,
        account_id: acct,
        user_id: user,
        phone_number_id: `pn-${tag}`,
        waba_id: `waba-${tag}`,
        access_token: encrypt(`token-${tag}`),
        verify_token: encrypt(`verify-${tag}`),
        status: 'connected',
        mirror_inbound_media: false,
      },
      contact: {
        id: `contact-${tag}`,
        account_id: acct,
        user_id: user,
        phone: SHARED_PHONE,
        name: `Customer ${tag}`,
        email: null,
        company: null,
        created_at: created,
        updated_at: created,
      },
      conversation: {
        id: `conv-${tag}`,
        account_id: acct,
        user_id: user,
        contact_id: `contact-${tag}`,
        status: 'open',
        unread_count: 0,
        last_message_text: 'hi',
        last_message_at: created,
        assigned_agent_id: null,
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
        created_at: created,
        updated_at: created,
      },
      message: {
        id: `msg-${tag}`,
        conversation_id: `conv-${tag}`,
        sender_type: 'customer',
        content_type: 'text',
        content_text: `hello from ${tag}`,
        message_id: `wamid.in-${tag}`,
        status: 'delivered',
        created_at: created,
      },
      apiKey: {
        id: `key-${tag}`,
        account_id: acct,
        created_by: user,
        name: `key ${tag}`,
        key_hash: hashApiKey(acct === A ? KEY_A : KEY_B),
        scopes: [...API_SCOPES],
        expires_at: null,
        revoked_at: null,
      },
      automation: {
        id: `auto-${tag}`,
        account_id: acct,
        user_id: user,
        name: `auto ${tag}`,
        description: null,
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
        execution_count: 0,
        created_at: created,
      },
      pending: {
        id: `pending-${tag}`,
        automation_id: `auto-${tag}`,
        account_id: acct,
        user_id: user,
        contact_id: `contact-${tag}`,
        log_id: null,
        parent_step_id: null,
        branch: null,
        next_step_position: 0,
        context: {},
        run_at: OLDER,
        status: 'pending',
      },
      flow: {
        id: `flow-${tag}`,
        account_id: acct,
        user_id: user,
        name: `flow ${tag}`,
        description: null,
        status: 'active',
        trigger_type: 'keyword',
        trigger_config: { keywords: ['hello'] },
        entry_node_id: 'start',
        fallback_policy: { on_timeout_hours: 24 },
        created_at: created,
      },
      flowNode: {
        id: `node-${tag}`,
        flow_id: `flow-${tag}`,
        node_key: 'start',
        node_type: 'end',
        config: {},
        created_at: created,
      },
      flowRun: {
        id: `run-${tag}`,
        flow_id: `flow-${tag}`,
        account_id: acct,
        user_id: user,
        contact_id: `contact-${tag}`,
        conversation_id: `conv-${tag}`,
        status: 'active',
        current_node_key: 'start',
        vars: {},
        reprompt_count: 0,
        started_at: OLDER,
        last_advanced_at: OLDER,
      },
      quickReply: {
        id: `qr-${tag}`,
        account_id: acct,
        user_id: user,
        title: `qr ${tag}`,
        kind: 'text',
        content_text: `snippet ${tag}`,
        interactive_payload: null,
        created_at: created,
      },
      broadcast: {
        id: `bc-${tag}`,
        account_id: acct,
        user_id: user,
        name: `bc ${tag}`,
        template_name: 'promo',
        template_language: 'en_US',
        status: 'sent',
        total_recipients: 1,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 1,
        delivery_locked_at: null,
        created_at: created,
        updated_at: created,
      },
      recipient: {
        id: `rcpt-${tag}`,
        broadcast_id: `bc-${tag}`,
        contact_id: `contact-${tag}`,
        status: 'failed',
        template_params: [],
        whatsapp_message_id: null,
        error_message: 'boom',
        created_at: created,
      },
      webhook: {
        id: `wh-${tag}`,
        account_id: acct,
        created_by: user,
        url: `https://hooks.${tag}.example/in`,
        secret: encrypt(`whsec-${tag}`),
        events: ['message.received'],
        is_active: true,
        failure_count: 0,
        created_at: created,
      },
      aiConfig: {
        id: `ai-${tag}`,
        account_id: acct,
        provider: 'openai',
        model: `gpt-${tag}`,
        api_key: encrypt(`sk-${tag}`),
        system_prompt: null,
        is_active: true,
        auto_reply_enabled: false,
        auto_reply_max_per_conversation: 3,
        handoff_agent_id: null,
        embeddings_api_key: null,
      },
      knowledge: {
        id: `kb-${tag}`,
        account_id: acct,
        created_by: user,
        title: `doc ${tag}`,
        content: `content ${tag}`,
        updated_at: created,
      },
      template: {
        id: `tpl-${tag}`,
        account_id: acct,
        user_id: user,
        name: 'promo',
        language: 'en_US',
        status: 'APPROVED',
        category: 'MARKETING',
        header_type: null,
        header_content: null,
        header_media_url: null,
        body_text: `Hello {{1}} from ${tag}`,
        footer_text: null,
        buttons: [],
        created_at: created,
      },
      usage: {
        id: `usage-${tag}`,
        account_id: acct,
        conversation_id: `conv-${tag}`,
        mode: 'draft',
        provider: 'openai',
        model: `gpt-${tag}`,
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        created_at: new Date().toISOString(),
      },
    };
  };

  const b = perAccount(B, USER_B, 'b');
  const a = perAccount(A, USER_A, 'a');
  const both = <K extends keyof typeof a>(k: K): Row[] => [b[k], a[k]];

  return new FakeDatabase(
    {
      accounts: both('account'),
      profiles: both('profile'),
      whatsapp_config: both('config'),
      contacts: both('contact'),
      conversations: both('conversation'),
      messages: both('message'),
      api_keys: both('apiKey'),
      automations: both('automation'),
      automation_steps: [],
      automation_logs: [],
      automation_pending_executions: both('pending'),
      flows: both('flow'),
      flow_nodes: both('flowNode'),
      flow_runs: both('flowRun'),
      flow_run_events: [],
      quick_replies: both('quickReply'),
      broadcasts: both('broadcast'),
      broadcast_recipients: both('recipient'),
      webhook_endpoints: both('webhook'),
      ai_configs: both('aiConfig'),
      ai_knowledge_documents: both('knowledge'),
      ai_usage_log: both('usage'),
      message_templates: both('template'),
      tags: [],
      contact_tags: [],
    },
    {
      // Migration 037: one transaction for the broadcast + recipients.
      create_broadcast_with_recipients: (args, db) => {
        const broadcastId = db.nextId('broadcasts');
        db.rows('broadcasts').push({
          id: broadcastId,
          account_id: args.p_account_id,
          user_id: args.p_user_id,
          name: args.p_name,
          template_name: args.p_template_name,
          template_language: args.p_template_language,
          status: 'sending',
          total_recipients: args.p_total_recipients,
          delivery_locked_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        const contactIds = args.p_contact_ids as string[];
        return contactIds.map((contactId) => {
          const id = db.nextId('broadcast_recipients');
          db.rows('broadcast_recipients').push({
            id,
            broadcast_id: broadcastId,
            contact_id: contactId,
            status: 'pending',
            template_params: [],
          });
          return {
            broadcast_id: broadcastId,
            recipient_id: id,
            contact_id: contactId,
          };
        });
      },
      bump_conversation_on_inbound: (args, db) => {
        const conv = db
          .rows('conversations')
          .find((c) => c.id === args.p_conversation_id);
        if (conv) {
          conv.unread_count = ((conv.unread_count as number) ?? 0) + 1;
          conv.last_message_text = args.p_last_message_text;
        }
        return null;
      },
      claim_ai_reply_slot: () => true,
    }
  );
}

// ---- helpers ---------------------------------------------------------

function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request(`https://crm.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const asKeyA = { authorization: `Bearer ${KEY_A}` };
const params = <T extends Record<string, string>>(p: T) => ({
  params: Promise.resolve(p),
});

async function drainAfter(): Promise<void> {
  while (h.after.length > 0) {
    const cb = h.after.shift()!;
    await cb();
  }
}

/** Every id belonging to B, as a flat set — nothing in a response may hit it. */
function idsOfB(): Set<string> {
  return h.db.idsOf(B);
}

/** Recursively collect every string value in a JSON payload. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, out));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => stringsIn(v, out));
  }
  return out;
}

function expectNoBIds(payload: unknown): void {
  const b = idsOfB();
  const leaked = stringsIn(payload).filter((s) => b.has(s));
  expect(leaked, `response leaked ids belonging to account B`).toEqual([]);
}

function expectBUnchanged(before: ReturnType<FakeDatabase['snapshot']>): void {
  expect(h.db.snapshot(B)).toEqual(before);
}

function inboundWebhookBody(phoneNumberId: string, text = 'hello') {
  return {
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '1',
                phone_number_id: phoneNumberId,
              },
              contacts: [
                { wa_id: '15551230000', profile: { name: 'Customer' } },
              ],
              messages: [
                {
                  id: `wamid.${Math.random().toString(36).slice(2)}`,
                  from: '15551230000',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  h.db = seed();
  h.actor = { userId: USER_A, accountId: A };
  h.after = [];
  h.meta.sends = [];
  h.webhookEvents = [];
  h.ingestedDocuments = [];
  h.validatedAiKeys = [];
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'cron-secret');
  vi.stubEnv('META_APP_ID', 'app-1');
});

// ============================================================
// The mechanism itself — what makes a missing filter detectable.
// ============================================================

describe('fake database: leak detection mechanism', () => {
  it('an unscoped service-role query returns rows from both accounts, B first', async () => {
    const { data } = await h.db.admin
      .from('contacts')
      .select('*')
      .like('phone', '%1230000');
    expect((data as Row[]).map((r) => r.account_id)).toEqual([B, A]);
  });

  it('the same query scoped by account_id returns only that account', async () => {
    const { data } = await h.db.admin
      .from('contacts')
      .select('*')
      .eq('account_id', A)
      .like('phone', '%1230000');
    expect((data as Row[]).map((r) => r.id)).toEqual(['contact-a']);
  });

  it('the cookie-session client hides the other account even without a filter (RLS)', async () => {
    const { data } = await h.db.asUser(h.actor).from('messages').select('*');
    expect((data as Row[]).map((r) => r.id)).toEqual(['msg-a']);
    const insert = await h.db
      .asUser(h.actor)
      .from('quick_replies')
      .insert({ account_id: B, title: 'x', kind: 'text' });
    expect(insert.error?.code).toBe('42501');
  });
});

// ============================================================
// Public API — every /api/v1 route runs on the service role.
// ============================================================

describe('/api/v1 (service role via API key)', () => {
  it('GET /me resolves the key to its own account only', async () => {
    const res = await v1Me.GET(req('GET', '/api/v1/me', undefined, asKeyA));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.account.id).toBe(A);
    expectNoBIds(body);
  });

  it("GET /contacts lists A's contacts and never B's, even with a search that matches both", async () => {
    const res = await v1Contacts.GET(
      req('GET', '/api/v1/contacts?search=Customer', undefined, asKeyA)
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.map((c: Row) => c.id)).toEqual(['contact-a']);
    expectNoBIds(body);
  });

  it("POST /contacts with the phone both accounts know resolves A's contact, not B's", async () => {
    const before = h.db.snapshot(B);
    const res = await v1Contacts.POST(
      req(
        'POST',
        '/api/v1/contacts',
        { phone: SHARED_PHONE, name: 'Renamed' },
        asKeyA
      )
    );
    const body = await res.json();
    expect(res.status).toBe(200); // matched, not created
    expect(body.data.id).toBe('contact-a');
    expectBUnchanged(before);
  });

  it("GET/PATCH /contacts/{id} with B's id is a 404 and touches nothing", async () => {
    const before = h.db.snapshot(B);
    const got = await v1ContactById.GET(
      req('GET', '/api/v1/contacts/contact-b', undefined, asKeyA),
      params({ id: 'contact-b' })
    );
    expect(got.status).toBe(404);
    const patched = await v1ContactById.PATCH(
      req('PATCH', '/api/v1/contacts/contact-b', { name: 'pwned' }, asKeyA),
      params({ id: 'contact-b' })
    );
    expect(patched.status).toBe(404);
    expectBUnchanged(before);

    const own = await v1ContactById.GET(
      req('GET', '/api/v1/contacts/contact-a', undefined, asKeyA),
      params({ id: 'contact-a' })
    );
    expect(own.status).toBe(200);
  });

  it("GET /conversations lists only A's; B's id → 404 for the row and its messages", async () => {
    const list = await v1Conversations.GET(
      req('GET', '/api/v1/conversations', undefined, asKeyA)
    );
    const listBody = await list.json();
    expect(listBody.data.map((c: Row) => c.id)).toEqual(['conv-a']);
    expectNoBIds(listBody);

    const one = await v1ConversationById.GET(
      req('GET', '/api/v1/conversations/conv-b', undefined, asKeyA),
      params({ id: 'conv-b' })
    );
    expect(one.status).toBe(404);

    const msgs = await v1ConversationMessages.GET(
      req('GET', '/api/v1/conversations/conv-b/messages', undefined, asKeyA),
      params({ id: 'conv-b' })
    );
    expect(msgs.status).toBe(404);

    const ownMsgs = await v1ConversationMessages.GET(
      req('GET', '/api/v1/conversations/conv-a/messages', undefined, asKeyA),
      params({ id: 'conv-a' })
    );
    const ownBody = await ownMsgs.json();
    expect(ownBody.data.map((m: Row) => m.id)).toEqual(['msg-a']);
    expectNoBIds(ownBody);
  });

  it("POST /messages to the shared phone sends through A's number into A's conversation", async () => {
    const before = h.db.snapshot(B);
    const res = await v1Messages.POST(
      req(
        'POST',
        '/api/v1/messages',
        { to: SHARED_PHONE, type: 'text', text: 'hi' },
        asKeyA
      )
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.contact_id).toBe('contact-a');
    expect(body.data.conversation_id).toBe('conv-a');
    expect(h.meta.sends.map((s) => s.args.phoneNumberId)).toEqual(['pn-a']);
    // The new message row hangs off A's conversation.
    const inserted = h.db
      .rows('messages')
      .find((m) => m.id === body.data.message_id);
    expect(inserted?.conversation_id).toBe('conv-a');
    // The "agent stepped in" flow pause ran on the service role — B's
    // active run must survive it.
    expect(h.db.rows('flow_runs').find((r) => r.id === 'run-b')?.status).toBe(
      'active'
    );
    expectBUnchanged(before);
  });

  it("POST /messages refuses a media_url that names B's storage object", async () => {
    const before = h.db.snapshot(B);
    const res = await v1Messages.POST(
      req(
        'POST',
        '/api/v1/messages',
        {
          to: SHARED_PHONE,
          type: 'image',
          media_url:
            'https://fake.supabase.co/storage/v1/object/public/chat-media/account-acct-b/1-secret.png',
        },
        asKeyA
      )
    );
    expect(res.status).toBe(403);
    expect(h.meta.sends).toEqual([]);
    expectBUnchanged(before);
  });

  it("POST /broadcasts creates under A, delivers through A's number; GET B's broadcast → 404", async () => {
    const before = h.db.snapshot(B);
    const res = await v1Broadcasts.POST(
      req(
        'POST',
        '/api/v1/broadcasts',
        {
          template_name: 'promo',
          recipients: [{ to: SHARED_PHONE, params: ['x'] }],
        },
        asKeyA
      )
    );
    const body = await res.json();
    expect(res.status).toBe(202);
    await drainAfter();

    const created = h.db
      .rows('broadcasts')
      .find((b) => b.id === body.data.broadcast_id);
    expect(created?.account_id).toBe(A);
    const recipients = h.db
      .rows('broadcast_recipients')
      .filter((r) => r.broadcast_id === body.data.broadcast_id);
    expect(recipients.map((r) => r.contact_id)).toEqual(['contact-a']);
    expect(h.meta.sends.map((s) => s.args.phoneNumberId)).toEqual(['pn-a']);
    // The template body persisted is A's template, not B's same-named one.
    expect(h.meta.sends[0].args.template).toMatchObject({ id: 'tpl-a' });
    expectBUnchanged(before);

    const foreign = await v1BroadcastById.GET(
      req('GET', '/api/v1/broadcasts/bc-b', undefined, asKeyA),
      params({ id: 'bc-b' })
    );
    expect(foreign.status).toBe(404);
  });

  it("webhooks: list is A-only; B's id → 404 on GET/PATCH/DELETE; POST lands in A", async () => {
    const before = h.db.snapshot(B);
    const list = await v1Webhooks.GET(
      req('GET', '/api/v1/webhooks', undefined, asKeyA)
    );
    const listBody = await list.json();
    expect(listBody.data.map((w: Row) => w.id)).toEqual(['wh-a']);
    expectNoBIds(listBody);

    for (const [fn, request] of [
      [
        v1WebhookById.GET,
        req('GET', '/api/v1/webhooks/wh-b', undefined, asKeyA),
      ],
      [
        v1WebhookById.PATCH,
        req('PATCH', '/api/v1/webhooks/wh-b', { is_active: false }, asKeyA),
      ],
      [
        v1WebhookById.DELETE,
        req('DELETE', '/api/v1/webhooks/wh-b', undefined, asKeyA),
      ],
    ] as const) {
      const res = await fn(request, params({ id: 'wh-b' }));
      expect(res.status).toBe(404);
    }

    const created = await v1Webhooks.POST(
      req(
        'POST',
        '/api/v1/webhooks',
        { url: 'https://hooks.a.example/new', events: ['message.received'] },
        asKeyA
      )
    );
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expect(
      h.db.rows('webhook_endpoints').find((w) => w.id === createdBody.data.id)
        ?.account_id
    ).toBe(A);
    expectBUnchanged(before);
  });
});

// ============================================================
// Dashboard send paths.
// ============================================================

describe('/api/whatsapp/send and /broadcast', () => {
  it("send: B's conversation_id → 404; A's sends through A's number and only pauses A's runs", async () => {
    const before = h.db.snapshot(B);
    const foreign = await waSend.POST(
      req('POST', '/api/whatsapp/send', {
        conversation_id: 'conv-b',
        message_type: 'text',
        content_text: 'hi',
      })
    );
    expect(foreign.status).toBe(404);
    expect(h.meta.sends).toEqual([]);

    const own = await waSend.POST(
      req('POST', '/api/whatsapp/send', {
        conversation_id: 'conv-a',
        message_type: 'text',
        content_text: 'hi',
      })
    );
    expect(own.status).toBe(200);
    expect(h.meta.sends.map((s) => s.args.phoneNumberId)).toEqual(['pn-a']);
    expect(h.db.rows('flow_runs').find((r) => r.id === 'run-a')?.status).toBe(
      'paused_by_agent'
    );
    expect(h.db.rows('flow_runs').find((r) => r.id === 'run-b')?.status).toBe(
      'active'
    );
    expectBUnchanged(before);
  });

  it("send by contact_id: B's contact → 404, nothing created", async () => {
    const before = h.db.snapshot(B);
    const res = await waSend.POST(
      req('POST', '/api/whatsapp/send', {
        contact_id: 'contact-b',
        message_type: 'text',
        content_text: 'hi',
      })
    );
    expect(res.status).toBe(404);
    expectBUnchanged(before);
  });

  it("broadcast: uses A's config and A's template row", async () => {
    const before = h.db.snapshot(B);
    const res = await waBroadcast.POST(
      req('POST', '/api/whatsapp/broadcast', {
        template_name: 'promo',
        recipients: [{ phone: SHARED_PHONE, params: ['x'] }],
      })
    );
    expect(res.status).toBe(200);
    expect(h.meta.sends.map((s) => s.args.phoneNumberId)).toEqual(['pn-a']);
    expect(h.meta.sends[0].args.template).toMatchObject({ id: 'tpl-a' });
    expectBUnchanged(before);
  });

  it("broadcast resume: B's broadcast cannot be claimed or delivered by A", async () => {
    const before = h.db.snapshot(B);
    const res = await waBroadcastResume.POST(
      req('POST', '/api/whatsapp/broadcast/bc-b/resume', { scope: 'failed' }),
      params({ id: 'bc-b' })
    );
    expect([404, 409]).toContain(res.status);
    await drainAfter();
    expect(h.meta.sends).toEqual([]);
    expectBUnchanged(before);
  });

  it("broadcast resume: A's failed recipients go out through A's number only", async () => {
    const before = h.db.snapshot(B);
    const res = await waBroadcastResume.POST(
      req('POST', '/api/whatsapp/broadcast/bc-a/resume', { scope: 'failed' }),
      params({ id: 'bc-a' })
    );
    expect(res.status).toBe(202);
    await drainAfter();
    expect(h.meta.sends.map((s) => s.args.phoneNumberId)).toEqual(['pn-a']);
    expect(
      h.db.rows('broadcast_recipients').find((r) => r.id === 'rcpt-a')?.status
    ).toBe('sent');
    expectBUnchanged(before);
  });
});

// ============================================================
// Inbound webhook — the account is resolved from phone_number_id.
// ============================================================

describe('/api/whatsapp/webhook (service role, tenant from phone_number_id)', () => {
  it("an inbound on A's number lands in A's conversation and matches A's contact, not B's same-numbered one", async () => {
    const before = h.db.snapshot(B);
    const res = await waWebhook.POST(
      req(
        'POST',
        '/api/whatsapp/webhook',
        inboundWebhookBody('pn-a', 'just a note'),
        {
          'x-hub-signature-256': 'sha256=stub',
        }
      )
    );
    expect(res.status).toBe(200);
    await drainAfter();

    const newMessages = h.db
      .rows('messages')
      .filter((m) => m.id !== 'msg-a' && m.id !== 'msg-b');
    expect(newMessages).toHaveLength(1);
    expect(newMessages[0].conversation_id).toBe('conv-a');
    // Fan-out (automations, flows, public webhooks) all ran for A.
    expect(h.webhookEvents.every((e) => e.accountId === A)).toBe(true);
    expect(h.db.rows('automation_logs').every((l) => l.account_id === A)).toBe(
      true
    );
    expect(
      h.db.rows('flow_run_events').every((e) => e.flow_run_id !== 'run-b')
    ).toBe(true);
    expectBUnchanged(before);
  });

  it("an inbound on B's number is B's business: nothing of A moves", async () => {
    const before = h.db.snapshot(A);
    await waWebhook.POST(
      req('POST', '/api/whatsapp/webhook', inboundWebhookBody('pn-b'), {
        'x-hub-signature-256': 'sha256=stub',
      })
    );
    await drainAfter();
    expect(h.db.snapshot(A)).toEqual(before);
    const newMessages = h.db
      .rows('messages')
      .filter((m) => m.id !== 'msg-a' && m.id !== 'msg-b');
    expect(newMessages.map((m) => m.conversation_id)).toEqual(['conv-b']);
  });

  it('an inbound for an unknown number is dropped without touching either account', async () => {
    const beforeA = h.db.snapshot(A);
    const beforeB = h.db.snapshot(B);
    await waWebhook.POST(
      req('POST', '/api/whatsapp/webhook', inboundWebhookBody('pn-nobody'), {
        'x-hub-signature-256': 'sha256=stub',
      })
    );
    await drainAfter();
    expect(h.db.snapshot(A)).toEqual(beforeA);
    expect(h.db.snapshot(B)).toEqual(beforeB);
  });
});

// ============================================================
// Scheduled tasks — no actor; each row must be processed under its own
// account.
// ============================================================

describe('scheduled tasks (service role, no actor)', () => {
  it('automations cron: each pending execution runs against its own automation and logs under its own account', async () => {
    const res = await automationsCron.GET(
      req('GET', '/api/automations/cron', undefined, {
        'x-cron-secret': 'cron-secret',
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.processed).toBe(2);
    // Both rows were processed, and the pass never crossed streams: every
    // log row's account is the account of the automation it ran.
    for (const log of h.db.rows('automation_logs')) {
      const automation = h.db
        .rows('automations')
        .find((a) => a.id === log.automation_id);
      expect(log.account_id).toBe(automation?.account_id);
    }
    expect(
      h.db
        .rows('automation_pending_executions')
        .map((p) => p.status)
        .sort()
    ).toEqual(['done', 'done']);
  });

  it("flows cron: sweeps stale runs of every account but writes only to each run's own rows", async () => {
    const res = await flowsCron.GET(
      req('GET', '/api/flows/cron', undefined, {
        'x-cron-secret': 'cron-secret',
      })
    );
    const body = await res.json();
    expect(body.swept).toBe(2);
    const events = h.db.rows('flow_run_events');
    expect(events.map((e) => e.flow_run_id).sort()).toEqual(['run-a', 'run-b']);
    for (const run of h.db.rows('flow_runs')) {
      expect(run.status).toBe('timed_out');
    }
    // Nothing but flow_runs / flow_run_events changed.
    const touched = new Set(
      h.db.log.filter((l) => l.op !== 'select').map((l) => l.table)
    );
    expect([...touched].sort()).toEqual(['flow_run_events', 'flow_runs']);
  });

  it('both crons refuse without the shared secret', async () => {
    const a = await automationsCron.GET(req('GET', '/api/automations/cron'));
    const f = await flowsCron.GET(req('GET', '/api/flows/cron'));
    expect(a.status).toBe(401);
    expect(f.status).toBe(401);
    expect(h.db.log).toEqual([]);
  });
});

// ============================================================
// AI routes.
// ============================================================

describe('/api/ai', () => {
  it("draft: B's conversation → 404; A's conversation logs usage under A via the service role", async () => {
    const before = h.db.snapshot(B);
    const foreign = await aiDraft.POST(
      req('POST', '/api/ai/draft', { conversation_id: 'conv-b' })
    );
    expect(foreign.status).toBe(404);

    const own = await aiDraft.POST(
      req('POST', '/api/ai/draft', { conversation_id: 'conv-a' })
    );
    expect(own.status).toBe(200);
    // logAiUsage is fire-and-forget; let the microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    const newUsage = h.db
      .rows('ai_usage_log')
      .filter((u) => !String(u.id).startsWith('usage-'));
    expect(newUsage).toHaveLength(1);
    expect(newUsage[0]).toMatchObject({
      account_id: A,
      conversation_id: 'conv-a',
      model: 'gpt-a',
    });
    expectBUnchanged(before);
  });

  it("config GET returns A's config, never B's model", async () => {
    const res = await aiConfig.GET();
    const body = await res.json();
    expect(body.model).toBe('gpt-a');
    expectNoBIds(body);
  });

  it("config POST/DELETE affect only A's configuration", async () => {
    const before = h.db.snapshot(B);
    const saved = await aiConfig.POST(
      req('POST', '/api/ai/config', {
        provider: 'openai',
        model: 'gpt-a',
        is_active: true,
        auto_reply_enabled: false,
        auto_reply_max_per_conversation: 3,
      })
    );
    expect(saved.status).toBe(200);
    expect(h.validatedAiKeys).toEqual([]); // unchanged credentials skip provider I/O
    expect(
      h.db.rows('ai_configs').find((c) => c.id === 'ai-a')?.is_active
    ).toBe(true);

    const removed = await aiConfig.DELETE();
    expect(removed.status).toBe(200);
    expect(
      h.db.rows('ai_configs').find((c) => c.id === 'ai-a')
    ).toBeUndefined();
    expectBUnchanged(before);
  });

  it("usage GET aggregates A's rows only", async () => {
    const res = await aiUsage.GET(req('GET', '/api/ai/usage?days=30'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(stringsIn(body)).not.toContain('gpt-b');
    expectNoBIds(body);
  });

  it("autoreply toggle on B's conversation → 404 and B untouched", async () => {
    const before = h.db.snapshot(B);
    const res = await aiAutoreply.POST(
      req('POST', '/api/ai/autoreply/conv-b', { paused: true }),
      params({ conversationId: 'conv-b' })
    );
    expect(res.status).toBe(404);
    expectBUnchanged(before);
  });

  it("knowledge GET lists A's documents only", async () => {
    const res = await aiKnowledge.GET();
    const body = await res.json();
    expect(body.documents.map((d: Row) => d.id)).toEqual(['kb-a']);
    expectNoBIds(body);
  });

  it("knowledge POST creates for A, while B's document cannot be read, changed, or deleted", async () => {
    const before = h.db.snapshot(B);
    const created = await aiKnowledge.POST(
      req('POST', '/api/ai/knowledge', {
        title: 'A only',
        content: 'private A content',
      })
    );
    const createdBody = await created.json();
    expect(created.status).toBe(200);
    expect(
      h.db.rows('ai_knowledge_documents').find((d) => d.id === createdBody.id)
        ?.account_id
    ).toBe(A);

    const foreignGet = await aiKnowledgeById.GET(
      req('GET', '/api/ai/knowledge/kb-b'),
      params({ id: 'kb-b' })
    );
    const foreignPatch = await aiKnowledgeById.PATCH(
      req('PATCH', '/api/ai/knowledge/kb-b', { title: 'pwned' }),
      params({ id: 'kb-b' })
    );
    const foreignDelete = await aiKnowledgeById.DELETE(
      req('DELETE', '/api/ai/knowledge/kb-b'),
      params({ id: 'kb-b' })
    );
    expect(foreignGet.status).toBe(404);
    expect(foreignPatch.status).toBe(404);
    expect(foreignDelete.status).toBe(200); // idempotent delete, but no foreign row is matched
    expectBUnchanged(before);
  });

  it("knowledge reindex loads and processes A's documents only", async () => {
    const before = h.db.snapshot(B);
    const res = await aiKnowledgeReindex.POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, reindexed: 1 });
    expect(h.ingestedDocuments).toEqual(['kb-a']);
    expectBUnchanged(before);
  });

  it("playground uses A's configuration and knowledge, never B's", async () => {
    const res = await aiPlayground.POST(
      req('POST', '/api/ai/playground', {
        messages: [{ role: 'user', content: 'hello' }],
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ reply: 'AI says hi', handoff: false });
    expectNoBIds(body);
  });

  it("test key falls back to A's stored key, not B's", async () => {
    const res = await aiTest.POST(
      req('POST', '/api/ai/test', { provider: 'openai', model: 'gpt-a' })
    );
    expect(res.status).toBe(200);
    expect(h.validatedAiKeys).toEqual(['sk-a']);
  });
});

// ============================================================
// Builder routes that write through the service role.
// ============================================================

describe('/api/automations (service-role writes)', () => {
  it('POST creates under A', async () => {
    const res = await automations.POST(
      req('POST', '/api/automations', {
        name: 'x',
        trigger_type: 'keyword_match',
      })
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.automation.account_id).toBe(A);
  });

  it("GET/PATCH/DELETE/duplicate on B's automation → 404, B unchanged", async () => {
    const before = h.db.snapshot(B);
    const got = await automationById.GET(
      req('GET', '/api/automations/auto-b'),
      params({ id: 'auto-b' })
    );
    expect(got.status).toBe(404);
    const patched = await automationById.PATCH(
      req('PATCH', '/api/automations/auto-b', { name: 'pwned' }),
      params({ id: 'auto-b' })
    );
    expect(patched.status).toBe(404);
    const deleted = await automationById.DELETE(
      req('DELETE', '/api/automations/auto-b'),
      params({ id: 'auto-b' })
    );
    expect(deleted.status).toBe(200);
    // DELETE answers ok regardless; what matters is that B's row survived.
    expect(
      h.db.rows('automations').find((a) => a.id === 'auto-b')
    ).toBeDefined();
    const dup = await automationDuplicate.POST(
      req('POST', '/api/automations/auto-b/duplicate'),
      params({ id: 'auto-b' })
    );
    expect(dup.status).toBe(404);
    expectBUnchanged(before);
  });
});

describe('/api/flows (service-role writes)', () => {
  it('POST creates under A', async () => {
    const res = await flows.POST(req('POST', '/api/flows', { name: 'f' }));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.flow.account_id).toBe(A);
  });

  it("GET/PUT/DELETE/activate on B's flow → 404, B unchanged", async () => {
    const before = h.db.snapshot(B);
    const got = await flowById.GET(
      req('GET', '/api/flows/flow-b'),
      params({ id: 'flow-b' })
    );
    expect(got.status).toBe(404);
    const put = await flowById.PUT(
      req('PUT', '/api/flows/flow-b', { name: 'pwned' }),
      params({ id: 'flow-b' })
    );
    expect(put.status).toBe(404);
    const del = await flowById.DELETE(
      req('DELETE', '/api/flows/flow-b'),
      params({ id: 'flow-b' })
    );
    expect(del.status).toBe(404);
    const act = await flowActivate.POST(
      req('POST', '/api/flows/flow-b/activate', { status: 'archived' }),
      params({ id: 'flow-b' })
    );
    expect(act.status).toBe(404);
    expectBUnchanged(before);
  });
});

describe('/api/quick-replies (service-role writes)', () => {
  it("POST creates under A; PATCH/DELETE on B's row change nothing", async () => {
    const created = await quickReplies.POST(
      req('POST', '/api/quick-replies', { title: 't', content_text: 'c' })
    );
    const body = await created.json();
    expect(created.status).toBe(201);
    expect(body.quick_reply.account_id).toBe(A);

    const before = h.db.snapshot(B);
    await quickReplyById.PATCH(
      req('PATCH', '/api/quick-replies/qr-b', { title: 'pwned' }),
      params({ id: 'qr-b' })
    );
    await quickReplyById.DELETE(
      req('DELETE', '/api/quick-replies/qr-b'),
      params({ id: 'qr-b' })
    );
    expectBUnchanged(before);
    expect(h.db.rows('quick_replies').find((q) => q.id === 'qr-b')?.title).toBe(
      'qr b'
    );
  });
});

describe('/api/whatsapp/config', () => {
  it("GET verifies A's number with A's token, never B's", async () => {
    const res = await waConfig.GET();
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(h.meta.sends).toEqual([
      {
        fn: 'verifyPhoneNumber',
        args: { phoneNumberId: 'pn-a', accessToken: 'token-a' },
      },
    ]);
    expectNoBIds(body);
  });

  it("POST refuses to claim B's phone number and leaves B's config alone", async () => {
    const before = h.db.snapshot(B);
    const res = await waConfig.POST(
      req('POST', '/api/whatsapp/config', {
        phone_number_id: 'pn-b',
        access_token: 'tok',
      })
    );
    expect(res.status).toBe(409);
    expect(h.meta.sends).toEqual([]);
    expectBUnchanged(before);
  });
});
