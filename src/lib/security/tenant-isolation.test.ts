import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDatabase, type Row } from './fake-supabase';
import {
  unscopedServiceRoleQueries,
  type ScopeWaiver,
} from './service-role-audit';
import { encrypt } from '@/lib/whatsapp/encryption';
import { hashApiKey } from '@/lib/api-keys/keys';
import { API_SCOPES } from '@/lib/api-keys/scopes';
import { currentPeriodStart } from '@/lib/billing/entitlements';

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
// And, after every single test, a fourth thing that does not depend on
// the test having thought of the right case: every query the route ran
// through the service role carried its account scope (see
// `service-role-audit.ts` and GLOBAL_WAIVERS below).
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
// Real UUIDs: the templates lifecycle route rejects a non-UUID template
// id outright, and a legacy `<uid>/…` storage path is only recognised as
// one when the first segment parses as a UUID.
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const TPL_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TPL_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SHARED_PHONE = '+15551230000';
// El MISMO BSUID en las dos cuentas. Meta lo emite por par
// portafolio/usuario, así que en rigor sería distinto para cada
// negocio; se comparte a propósito para que un fallo de acotación
// (buscar el contacto por `wa_user_id` sin `account_id`) case con la
// fila equivocada y el test lo vea. Fase 6 §5.
const SHARED_WA_USER_ID = 'US.1349700000000001';
const KEY_A = 'wacrm_live_keyA_keyA_keyA_keyA_keyA_keyA_keyA';
const KEY_B = 'wacrm_live_keyB_keyB_keyB_keyB_keyB_keyB_keyB';

const h = vi.hoisted(() => ({
  db: null as unknown as import('./fake-supabase').FakeDatabase,
  actor: { userId: '', accountId: 'acct-a' } as {
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
  /** Browser cookie jar, for the support-session routes. */
  cookies: new Map<string, string>(),
}));

// ---- module mocks --------------------------------------------------

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => h.db.asUser(h.actor),
}));

// The support-session routes read and write a cookie. A plain in-memory
// jar is enough: what this suite cares about is which account the queries
// they run are scoped to, not the Set-Cookie header.
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      h.cookies.has(name) ? { name, value: h.cookies.get(name) } : undefined,
    set: (name: string, value: string) => h.cookies.set(name, value),
    delete: (name: string) => h.cookies.delete(name),
  }),
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
    // Template lifecycle. Kept out of dry-run mode on purpose: the
    // dry-run short-circuit skips the header-handle step, which is the
    // one place those routes touch the service-role client.
    submitMessageTemplate: record('submitMessageTemplate', {
      id: 'meta-tpl-new',
      status: 'PENDING',
    }),
    editMessageTemplate: record('editMessageTemplate', { success: true }),
    deleteMessageTemplate: record('deleteMessageTemplate', { success: true }),
    uploadResumableMedia: record('uploadResumableMedia', {
      handle: 'HANDLE-1',
    }),
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
import * as v1WebhookDeliveries from '@/app/api/v1/webhooks/[id]/deliveries/route';
import * as v1WebhookRetry from '@/app/api/v1/webhooks/[id]/deliveries/[deliveryId]/retry/route';
import * as v1WebhookTest from '@/app/api/v1/webhooks/[id]/test/route';
import * as v1WebhookRotate from '@/app/api/v1/webhooks/[id]/rotate-secret/route';
import * as waSend from '@/app/api/whatsapp/send/route';
import * as waBroadcast from '@/app/api/whatsapp/broadcast/route';
import * as waBroadcastResume from '@/app/api/whatsapp/broadcast/[id]/resume/route';
import * as waWebhook from '@/app/api/whatsapp/webhook/route';
import * as waConfig from '@/app/api/whatsapp/config/route';
import * as waConfigById from '@/app/api/whatsapp/config/[id]/route';
import * as waEmbeddedSignup from '@/app/api/whatsapp/embedded-signup/route';
import * as waTemplateById from '@/app/api/whatsapp/templates/[id]/route';
import * as waTemplateSubmit from '@/app/api/whatsapp/templates/submit/route';
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
import { getCurrentAccount } from '@/lib/auth/account';
import * as platformImpersonate from '@/app/api/platform/impersonate/route';
import * as platformImpersonateStop from '@/app/api/platform/impersonate/stop/route';
import * as platformAccounts from '@/app/api/platform/accounts/route';
import * as platformAccountById from '@/app/api/platform/accounts/[id]/route';
import * as platformAccountHold from '@/app/api/platform/accounts/[id]/hold/route';
// Fase 7 §3. Van al final de la lista a propósito: la otra mitad de la
// fase toca este mismo archivo en paralelo y así no chocan los dos.
import * as v1Templates from '@/app/api/v1/templates/route';
import * as v1TemplateById from '@/app/api/v1/templates/[id]/route';
import * as v1TemplatesSync from '@/app/api/v1/templates/sync/route';

// ---- seed ------------------------------------------------------------

const PAST = '2026-01-01T00:00:00.000Z';
const OLDER = '2025-12-31T00:00:00.000Z';
/** Far enough out that the seeded subscriptions are never mid-lapse. */
const FUTURE = '2099-01-01T00:00:00.000Z';

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
        // Fase 4 §1: each account's only number is its default. Without
        // it the resolver falls to step 4 (oldest survivor), and B's row
        // is seeded first — so a missing account filter would land on B.
        is_default: true,
        created_at: created,
      },
      contact: {
        id: `contact-${tag}`,
        account_id: acct,
        user_id: user,
        phone: SHARED_PHONE,
        wa_user_id: SHARED_WA_USER_ID,
        wa_username: `cliente_${tag}`,
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
        whatsapp_config_id: `cfg-${tag}`,
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
      // Fase 7 §4: la bitácora de entregas es de la cuenta y su
      // `payload` lleva datos del cliente final.
      webhookDelivery: {
        id: `whd-${tag}`,
        account_id: acct,
        endpoint_id: `wh-${tag}`,
        event: 'message.received',
        payload: {
          id: `evt-${tag}`,
          event: 'message.received',
          occurred_at: created,
          account_id: acct,
          data: { text: `secreto de ${tag}` },
        },
        attempt: 1,
        status: 'failed',
        next_attempt_at: created,
        last_status_code: 500,
        last_error: 'endpoint responded 500',
        created_at: created,
        delivered_at: null,
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
        id: acct === A ? TPL_A : TPL_B,
        meta_template_id: `meta-tpl-${tag}`,
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
      // Fase 3: both accounts are on the same plan, ACTIVE, with room
      // to spare — the enforcement layer (`assertWritable`,
      // `assertPlanFeature`, `assertQuota`) now runs on nearly every
      // route here, and an account without these rows 500s before the
      // leak it is being tested for could ever happen. The point of the
      // suite is unchanged: what is audited is whether the billing
      // queries carry their own account scope.
      subscription: {
        id: `sub-${tag}`,
        account_id: acct,
        plan_id: 'pro',
        status: 'active',
        provider: 'paypal',
        provider_subscription_id: `paypal-${tag}`,
        cycle: 'month',
        trial_ends_at: null,
        grace_until: null,
        current_period_end: FUTURE,
        cancel_at_period_end: false,
        last_event_at: null,
        created_at: created,
        updated_at: created,
      },
      usageCounter: {
        id: `counter-${tag}`,
        account_id: acct,
        metric: 'messages_out',
        period_start: currentPeriodStart(),
        value: 1,
        updated_at: created,
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
      webhook_deliveries: both('webhookDelivery'),
      ai_configs: both('aiConfig'),
      ai_knowledge_documents: both('knowledge'),
      ai_usage_log: both('usage'),
      message_templates: both('template'),
      subscriptions: both('subscription'),
      usage_counters: both('usageCounter'),
      // The price list is a global catalogue with no account_id: one
      // row shared by every tenant, seeded by migration 041.
      plans: [
        {
          id: 'pro',
          name: 'Pro',
          price_usd_month: 79,
          price_usd_year: 790,
          limits: {
            operators: 10,
            contacts: 10000,
            messages_out: 15000,
            ai_replies: 3000,
            broadcast_recipients: 10000,
            knowledge_documents: 50,
            numbers: 1,
            retention_months: 24,
          },
          features: [
            'ai_autoreply',
            'ai_knowledge',
            'auto_assign',
            'api',
            'webhooks',
          ],
          is_public: true,
          sort_order: 2,
        },
      ],
      tags: [],
      contact_tags: [],
      // Migration 055. Seeded empty: nobody operates the platform until a
      // row is put here by hand, and the tests that need one add it.
      platform_admins: [],
      impersonation_log: [],
      // Migrations 048 and 041. Declared even though empty so that
      // merely READING them does not make the table appear and show up
      // as a difference in an account snapshot.
      checkout_intents: [],
      billing_events: [],
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
      // Migration 041: upsert keyed by (account_id, metric, period).
      // Modelled per account so a counter written against the wrong
      // tenant is visible in the snapshot of B.
      increment_usage: (args, db) => {
        const accountId = args.p_account_id as string;
        const metric = args.p_metric as string;
        const period = currentPeriodStart();
        const row = db
          .rows('usage_counters')
          .find(
            (c) =>
              c.account_id === accountId &&
              c.metric === metric &&
              c.period_start === period
          );
        const delta = Number(args.p_delta ?? 1);
        if (row) {
          row.value = Number(row.value ?? 0) + delta;
          return row.value;
        }
        db.rows('usage_counters').push({
          id: db.nextId('usage_counters'),
          account_id: accountId,
          metric,
          period_start: period,
          value: delta,
          updated_at: new Date().toISOString(),
        });
        return delta;
      },
      // Migration 058: the census of the platform panel. Cross-account by
      // definition — it is the list of every customer — and granted to
      // `service_role` alone. Modelled thinly: one row per account, with
      // the aggregates the panel reads.
      platform_account_list: (args, db) => {
        const search = ((args.p_search as string | null) ?? '')
          .trim()
          .toLowerCase();
        const all = db.rows('accounts').filter(
          (a) =>
            !search ||
            String(a.name ?? '')
              .toLowerCase()
              .includes(search) ||
            a.id === search
        );
        return all.map((a) => {
          const sub = db
            .rows('subscriptions')
            .find((r) => r.account_id === a.id);
          return {
            account_id: a.id,
            name: a.name,
            created_at: a.created_at ?? PAST,
            member_count: db
              .rows('profiles')
              .filter((pr) => pr.account_id === a.id).length,
            plan_id: sub?.plan_id ?? null,
            subscription_status: sub?.status ?? null,
            manual_hold_at: sub?.manual_hold_at ?? null,
            trial_ends_at: sub?.trial_ends_at ?? null,
            current_period_end: sub?.current_period_end ?? null,
            grace_until: sub?.grace_until ?? null,
            last_activity_at: null,
            usage: {},
            total_count: all.length,
          };
        });
      },
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

/**
 * Un entrante como los de abril de 2026: sin `from` ni `wa_id`, con el
 * BSUID en `from_user_id` / `contacts[].user_id`. Fase 6 §5.
 */
function inboundBsuidWebhookBody(phoneNumberId: string, text = 'hola') {
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
                {
                  user_id: SHARED_WA_USER_ID,
                  profile: { name: 'Customer', username: 'cliente' },
                },
              ],
              messages: [
                {
                  id: `wamid.${Math.random().toString(36).slice(2)}`,
                  from_user_id: SHARED_WA_USER_ID,
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

// ---- the per-query property ------------------------------------------
//
// Case-by-case leak tests answer "does this route leak today". They say
// nothing about the query a future patch adds. The audit below closes
// that: after EVERY test, each query the routes ran through the service
// role must carry its account scope — a filter on `account_id`, an
// `account_id` on the rows it writes, the parent key of a table that has
// no such column, or an account argument on an RPC.
//
// What is left is the handful of queries that genuinely cannot carry an
// account: they are the ones that RESOLVE the account, or the cron
// sweeps that run across all of them by design. Each is waived here by
// name, with the reason, and the waiver is as narrow as the query.

const GLOBAL_WAIVERS: ScopeWaiver[] = [
  {
    table: 'api_keys',
    op: 'select',
    by: ['key_hash'],
    reason:
      'This IS the tenant resolver: the presented key hash is what yields an ' +
      'account_id (src/lib/api-keys/store.ts). Nothing upstream of it knows ' +
      'the account yet.',
  },
  {
    table: 'api_keys',
    op: 'update',
    by: ['id'],
    reason:
      'Fire-and-forget last_used_at bump on the exact row the hash lookup ' +
      'above returned; the id never comes from the request.',
  },
  {
    table: 'whatsapp_config',
    op: 'select',
    by: ['phone_number_id'],
    reason:
      'Tenant resolver for inbound webhooks (the account is whatever owns ' +
      "Meta's phone_number_id) and, in /api/whatsapp/config POST, the " +
      "uniqueness guard that refuses to claim another account's number — " +
      'an account filter there would defeat the check.',
  },
  {
    table: 'contacts',
    op: 'update',
    by: ['id'],
    reason:
      'Reads as one route but covers ALL of them: waivers match on ' +
      'table + op + filtered columns, so this one blesses every write to a ' +
      "contact by bare row id — the webhook's profile-name refresh " +
      '(/api/whatsapp/webhook), the working-phone rewrite of both ' +
      'meta-send engines, and — since it already carries account_id and so ' +
      "doesn't need the waiver today — the PATCH of /api/v1/contacts/[id] " +
      'if that filter ever went away. Each of those updates a row read one ' +
      "query earlier with .eq('account_id', …), which is where the tenancy " +
      'is actually enforced; that previous read is what the audit still ' +
      'guards. Known limit, and the price of it is that a lost filter on ' +
      'a contacts UPDATE by id goes unnoticed. Adding the redundant ' +
      'account filter to those call sites would retire the waiver ' +
      '(implementation report, debt 2).',
  },
  {
    table: 'conversations',
    op: 'update',
    by: ['id'],
    reason:
      'Bumps a conversation the handler already loaded under its account.',
  },
  {
    table: 'rpc:bump_conversation_on_inbound',
    reason:
      'Takes the conversation id resolved under the account and touches the ' +
      'counters of that single row (migration 038).',
  },
  {
    table: 'broadcasts',
    op: 'update',
    by: ['id'],
    reason:
      'Progress and finalisation counters for the broadcast whose id came ' +
      'from the account-scoped create RPC or an account-scoped read (resume).',
  },
  {
    table: 'broadcast_recipients',
    op: 'update',
    by: ['id'],
    reason:
      'Per-recipient delivery result. The table has no account_id column and ' +
      'the row id comes from the delivery plan, built off an account-scoped ' +
      'broadcast_id.',
  },
  {
    table: 'flow_runs',
    op: 'update',
    by: ['id'],
    reason:
      "Advances or pauses the run loaded with .eq('account_id', …) (flows " +
      'engine, agent-stepped-in pause) or claimed by the cron sweep below.',
  },
  {
    table: 'flow_runs',
    op: 'select',
    by: ['status'],
    reason:
      'Cron sweep: timing out stale runs is a cross-account job by design ' +
      '(/api/flows/cron), and it writes back only to the runs it read.',
  },
  {
    table: 'automation_pending_executions',
    op: 'select',
    by: ['status'],
    reason:
      'Cron sweep across accounts, same shape as the flow_runs one above ' +
      '(/api/automations/cron).',
  },
  {
    table: 'automation_pending_executions',
    op: 'update',
    by: ['id'],
    reason: 'Claims / marks the queued row the sweep just read.',
  },
  {
    table: 'platform_admins',
    op: 'select',
    by: ['user_id'],
    reason:
      'The platform operator is not a tenant: `platform_admins` has no ' +
      'account_id and an account filter on it would be meaningless. The ' +
      "lookup is keyed by the CALLER'S OWN authenticated uid, which never " +
      'comes from the request body (src/lib/auth/platform-admins.ts), and ' +
      'the table is readable from the client only by platform admins ' +
      'themselves (migration 055).',
  },
  {
    table: 'impersonation_log',
    op: 'update',
    by: ['ended_at', 'expires_at'],
    reason:
      'The expiry sweep (sweepExpiredSupportSessions). Cross-account by ' +
      'design: it closes every support-session row whose deadline has ' +
      'passed, whoever opened it, and the bitácora belongs to the platform ' +
      'rather than to a tenant. It writes only `ended_at` / `ended_reason` ' +
      'on rows that were already past `expires_at`, reads nothing and ' +
      'moves no customer data. The OTHER update on this table — closing ' +
      'one named session — filters by `account_id` and is not waived.',
  },
  {
    table: 'rpc:platform_account_list',
    by: [],
    reason:
      'THE census. Listing every company of the service is the entire ' +
      'job of the platform panel (fase 4 §2), so there is no account to ' +
      'scope it by — an account filter here would make the feature ' +
      'impossible rather than safer. What bounds it instead: the ' +
      'function is granted to `service_role` and to NO client role ' +
      '(migration 058, asserted in verify-schema.sql), it is not ' +
      'SECURITY DEFINER so a mis-grant would still meet the RLS, and ' +
      'its only caller is GET /api/platform/accounts, which starts with ' +
      'requirePlatformAdmin(). A company owner gets 403 before it runs — ' +
      'and there is a test below that says so.',
  },
  {
    table: 'billing_events',
    op: 'select',
    by: ['provider', 'event_type'],
    reason:
      'The gateway log has NO account_id column at all (migration 041 ' +
      'makes it the global record of what PayPal sent). The tenant ' +
      "filter is the list of THIS account's PayPal subscription ids, " +
      'collected one query earlier from `subscriptions` and ' +
      '`checkout_intents` — both scoped by account_id, both holding that ' +
      'id under a UNIQUE constraint, so an id in the list cannot belong ' +
      'to anyone else. Applied as a database filter (`.in(...)`), never ' +
      'as a scan filtered afterwards in our process, and skipped ' +
      'entirely when the list is empty.',
  },
  {
    table: 'plans',
    op: 'select',
    by: ['id'],
    reason:
      'The price list, not tenant data: `plans` has NO account_id column ' +
      '(migration 041 makes it a global catalogue keyed by a text id — ' +
      "'inicio' | 'pro' | 'negocio') and every account reads the same three " +
      'rows. There is no filter to add here; the tenancy of the billing ' +
      'layer lives one query earlier, in the `subscriptions` read that ' +
      "yields this plan id, and that one does carry .eq('account_id', …) — " +
      'audited, unwaived, on every route below. The only thing this read ' +
      'can leak is a public price. Waived by id so an unfiltered ' +
      '`select * from plans` on a covered route would still be reported.',
  },
];

// No waiver for `automations`: the two that used to live here rested on
// "user_id is narrower than the account", which is false — see the
// ex-member test below.

/** Extra waivers for the current test only; reset in `beforeEach`. */
let extraWaivers: ScopeWaiver[] = [];

afterEach(() => {
  const violations = unscopedServiceRoleQueries(h.db.log, [
    ...GLOBAL_WAIVERS,
    ...extraWaivers,
  ]);
  expect(
    violations.map((v) => v.message),
    'service-role queries ran without an account scope; add the filter to ' +
      'the route, or a waiver with its reason if the query resolves the ' +
      'tenant'
  ).toEqual([]);
});

beforeEach(() => {
  h.db = seed();
  h.actor = { userId: USER_A, accountId: A };
  extraWaivers = [];
  h.after = [];
  h.meta.sends = [];
  h.webhookEvents = [];
  h.ingestedDocuments = [];
  h.validatedAiKeys = [];
  h.cookies = new Map();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake.supabase.co');
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'cron-secret');
  vi.stubEnv('META_APP_ID', 'app-1');
});

// ============================================================
// The mechanism itself — what makes a missing filter detectable.
// ============================================================

describe('fake database: leak detection mechanism', () => {
  it('an unscoped service-role query returns rows from both accounts, B first', async () => {
    extraWaivers.push({
      table: 'contacts',
      op: 'select',
      reason:
        'The unscoped query IS the subject of this test — it demonstrates ' +
        'what the audit catches everywhere else.',
    });
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

  it('la idempotencia de la fase 7 §1 no cruza cuentas: misma Idempotency-Key, dos mensajes', async () => {
    // Lo que de verdad afirma este test lo afirma la auditoría que corre
    // en cada `afterEach`: toda consulta que `withIdempotency` lanza por
    // el rol de servicio sobre `api_idempotency_keys` tiene que llevar su
    // `account_id`. Si alguien la quita, esto falla aunque las
    // aserciones de abajo sigan pasando.
    //
    // (La reproducción de respuestas la cubre
    // `src/lib/api/v1/idempotency.test.ts`, que emula el índice único;
    // esta base falsa no lo hace y aquí solo interesa el aislamiento.)
    const payload = { to: SHARED_PHONE, type: 'text', text: 'hola' };
    const header = { 'Idempotency-Key': 'la-misma-clave' };

    const asA = await v1Messages.POST(
      req('POST', '/api/v1/messages', payload, { ...asKeyA, ...header })
    );
    expect(asA.status).toBe(201);

    const asB = await v1Messages.POST(
      req('POST', '/api/v1/messages', payload, {
        authorization: `Bearer ${KEY_B}`,
        ...header,
      })
    );
    expect(asB.status).toBe(201);

    // Cada cuenta guarda su propia fila bajo su propia clave de API:
    // ninguna de las dos puede alcanzar la de la otra.
    const stored = h.db.rows('api_idempotency_keys');
    expect(stored.map((r) => r.account_id).sort()).toEqual([A, B].sort());
    expect(new Set(stored.map((r) => r.api_key_id)).size).toBe(2);

    // Y el mensaje de cada una cayó en su propia conversación.
    const bodyA = await asA.json();
    const bodyB = await asB.json();
    expect(bodyA.data.conversation_id).toBe('conv-a');
    expect(bodyB.data.conversation_id).toBe('conv-b');
    expect(bodyA.data.message_id).not.toBe(bodyB.data.message_id);
  });

  it('POST /messages con `to_user_id` escribe al contacto de A, no al de B (fase 6 §5)', async () => {
    const before = h.db.snapshot(B);
    const res = await v1Messages.POST(
      req(
        'POST',
        '/api/v1/messages',
        { to_user_id: SHARED_WA_USER_ID, type: 'text', text: 'hola' },
        asKeyA
      )
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.contact_id).toBe('contact-a');
    expect(body.data.conversation_id).toBe('conv-a');
    expect(h.meta.sends.map((s) => s.args.phoneNumberId)).toEqual(['pn-a']);
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
    expect(h.meta.sends[0].args.template).toMatchObject({ id: TPL_A });
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

  // ---- fase 7 §4: bitácora de entregas ----

  it('deliveries: solo las de A; el endpoint y la entrega de B → 404; el payload no sale', async () => {
    const before = h.db.snapshot(B);

    const list = await v1WebhookDeliveries.GET(
      req('GET', '/api/v1/webhooks/wh-a/deliveries', undefined, asKeyA),
      params({ id: 'wh-a' })
    );
    const listBody = await list.json();
    expect(list.status).toBe(200);
    expect(listBody.data.map((d: Row) => d.id)).toEqual(['whd-a']);
    // Ni el payload ni el account_id viajan en la vista pública.
    expect(listBody.data[0]).not.toHaveProperty('payload');
    expect(listBody.data[0]).not.toHaveProperty('account_id');
    expectNoBIds(listBody);

    // El endpoint de B no existe para A.
    const foreignList = await v1WebhookDeliveries.GET(
      req('GET', '/api/v1/webhooks/wh-b/deliveries', undefined, asKeyA),
      params({ id: 'wh-b' })
    );
    expect(foreignList.status).toBe(404);

    // Reintentar una entrega de B, nombrando su endpoint o el propio.
    for (const [endpointId, deliveryId] of [
      ['wh-b', 'whd-b'],
      ['wh-a', 'whd-b'],
    ]) {
      const res = await v1WebhookRetry.POST(
        req(
          'POST',
          `/api/v1/webhooks/${endpointId}/deliveries/${deliveryId}/retry`,
          undefined,
          asKeyA
        ),
        params({ id: endpointId, deliveryId })
      );
      expect(res.status).toBe(404);
    }

    // Probar y rotar el secreto del endpoint de B.
    const foreignTest = await v1WebhookTest.POST(
      req('POST', '/api/v1/webhooks/wh-b/test', undefined, asKeyA),
      params({ id: 'wh-b' })
    );
    expect(foreignTest.status).toBe(404);

    const foreignRotate = await v1WebhookRotate.POST(
      req('POST', '/api/v1/webhooks/wh-b/rotate-secret', undefined, asKeyA),
      params({ id: 'wh-b' })
    );
    expect(foreignRotate.status).toBe(404);

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
    expect(h.meta.sends[0].args.template).toMatchObject({ id: TPL_A });
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

  it('un entrante por BSUID en el número de A casa con el contacto de A, no con el de B (mismo wa_user_id)', async () => {
    const before = h.db.snapshot(B);
    const res = await waWebhook.POST(
      req('POST', '/api/whatsapp/webhook', inboundBsuidWebhookBody('pn-a'), {
        'x-hub-signature-256': 'sha256=stub',
      })
    );
    expect(res.status).toBe(200);
    await drainAfter();

    // Ni un contacto nuevo: el de A ya tenía ese BSUID.
    expect(h.db.rows('contacts')).toHaveLength(2);
    const newMessages = h.db
      .rows('messages')
      .filter((m) => m.id !== 'msg-a' && m.id !== 'msg-b');
    expect(newMessages).toHaveLength(1);
    expect(newMessages[0].conversation_id).toBe('conv-a');
    expectBUnchanged(before);
  });

  it('un estado de entrega del wamid compartido solo mueve la fila de A', async () => {
    // Las dos cuentas tienen una fila de difusión con el MISMO wamid:
    // Meta no garantiza que sea único entre números (migración 009).
    for (const row of h.db.rows('broadcast_recipients')) {
      row.whatsapp_message_id = 'wamid.SHARED';
      row.status = 'sent';
    }
    const before = h.db.snapshot(B);

    await waWebhook.POST(
      req(
        'POST',
        '/api/whatsapp/webhook',
        {
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
                      phone_number_id: 'pn-a',
                    },
                    statuses: [
                      {
                        id: 'wamid.SHARED',
                        status: 'delivered',
                        timestamp: '1700000000',
                        recipient_user_id: SHARED_WA_USER_ID,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        { 'x-hub-signature-256': 'sha256=stub' }
      )
    );
    await drainAfter();

    expect(
      h.db.rows('broadcast_recipients').find((r) => r.id === 'rcpt-a')?.status
    ).toBe('delivered');
    expectBUnchanged(before);
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
    expect(deleted.status).toBe(404);
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

  // The PATCH above 404s at the ownership guard, so it never reaches
  // the service-role UPDATE underneath. This one does: it patches A's
  // own automation, the write executes, and the audit in `afterEach`
  // requires it to carry `account_id` — the same treatment flows got.
  // `is_active: false` keeps the activation validator out of the way so
  // the request gets all the way to the UPDATE.

  it("PATCH edits A's own automation and leaves B's alone", async () => {
    const before = h.db.snapshot(B);
    const res = await automationById.PATCH(
      req('PATCH', '/api/automations/auto-a', {
        name: 'renamed by A',
        is_active: false,
      }),
      params({ id: 'auto-a' })
    );
    expect(res.status).toBe(200);
    expect(
      h.db.rows('automations').find((a) => a.id === 'auto-a')
    ).toMatchObject({ name: 'renamed by A', is_active: false, account_id: A });
    expect(
      h.db.rows('automations').find((a) => a.id === 'auto-b')
    ).toMatchObject({ name: 'auto b', is_active: true });
    expectBUnchanged(before);
  });

  // Positive paths for the other two service-role writes of this route.
  // Without them the DELETE and the duplicate INSERT never execute, and
  // the filters they carry are asserted by nobody: the 404 tests above
  // stop at the ownership gate.

  it("DELETE removes A's own automation and leaves B's alone", async () => {
    const before = h.db.snapshot(B);
    const res = await automationById.DELETE(
      req('DELETE', '/api/automations/auto-a'),
      params({ id: 'auto-a' })
    );
    expect(res.status).toBe(200);
    expect(h.db.rows('automations').map((a) => a.id)).toEqual(['auto-b']);
    expectBUnchanged(before);
  });

  it("duplicate clones A's automation into A", async () => {
    const before = h.db.snapshot(B);
    const res = await automationDuplicate.POST(
      req('POST', '/api/automations/auto-a/duplicate'),
      params({ id: 'auto-a' })
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.automation).toMatchObject({
      account_id: A,
      user_id: USER_A,
      name: 'auto a (Copy)',
      is_active: false,
    });
    expect(
      h.db.rows('automations').filter((a) => a.account_id === B)
    ).toHaveLength(1);
    expectBUnchanged(before);
  });

  // The case that makes `user_id` useless as a tenant boundary, and the
  // reason these routes carry `account_id` instead of a waiver.
  //
  // `remove_account_member` (migration 018) drops the expelled member
  // into a fresh personal account, and `redeem_invitation` (019) moves a
  // profile into the inviting one. Either way `profiles.account_id`
  // changes while the rows the user authored stay behind with
  // `account_id = A, user_id = U`. The session cookie is still valid and
  // `getCurrentAccount` reads the profile live, so the caller passes the
  // role check as owner of their NEW account — and a query filtered only
  // by `id + user_id` would still match A's automation.
  it("an ex-member of A cannot read, delete or clone A's automation from their new account", async () => {
    const C = 'acct-c';
    h.db.rows('accounts').push({
      id: C,
      name: 'Company C',
      owner_user_id: USER_A,
    });
    const movedProfile = h.db
      .rows('profiles')
      .find((p) => p.user_id === USER_A)!;
    movedProfile.account_id = C;
    movedProfile.account_role = 'owner';
    // Same user id, same session — only the profile moved. `auto-a`
    // still reads `account_id: A, user_id: USER_A`.
    h.actor = { userId: USER_A, accountId: C };
    // Snapshot after the move: the profile row left A with the user.
    const beforeA = h.db.snapshot(A);

    const got = await automationById.GET(
      req('GET', '/api/automations/auto-a'),
      params({ id: 'auto-a' })
    );
    expect(got.status).toBe(404);

    const deleted = await automationById.DELETE(
      req('DELETE', '/api/automations/auto-a'),
      params({ id: 'auto-a' })
    );
    expect(deleted.status).toBe(404);

    const patched = await automationById.PATCH(
      req('PATCH', '/api/automations/auto-a', {
        name: 'pwned',
        is_active: false,
      }),
      params({ id: 'auto-a' })
    );
    expect(patched.status).toBe(404);

    const dup = await automationDuplicate.POST(
      req('POST', '/api/automations/auto-a/duplicate'),
      params({ id: 'auto-a' })
    );
    expect(dup.status).toBe(404);

    // A's automation is still there, untouched, and nothing new was
    // written into A.
    expect(
      h.db.rows('automations').find((a) => a.id === 'auto-a')
    ).toMatchObject({ name: 'auto a', is_active: true, account_id: A });
    expect(
      h.db.rows('automations').filter((a) => a.account_id === A)
    ).toHaveLength(1);
    expect(h.db.snapshot(A)).toEqual(beforeA);
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

  // The 404s above stop at the ownership guard, so they never reach the
  // service-role writes underneath. These run them for real: every
  // admin query in PUT / DELETE / activate executes, and the audit in
  // `afterEach` requires each one to carry its account scope.

  it("PUT rewrites A's flow and its node graph, leaving B's alone", async () => {
    const before = h.db.snapshot(B);
    const res = await flowById.PUT(
      req('PUT', '/api/flows/flow-a', {
        name: 'renamed by A',
        nodes: [
          { node_key: 'start', node_type: 'send_message', config: {} },
          { node_key: 'bye', node_type: 'end', config: {} },
        ],
      }),
      params({ id: 'flow-a' })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.flow.id).toBe('flow-a');
    expect(body.flow.name).toBe('renamed by A');
    // The response is the re-read: only A's flow and only A's nodes.
    expect(body.nodes.map((n: Row) => n.flow_id)).toEqual(['flow-a', 'flow-a']);
    expectNoBIds(body);
    // Delete-then-insert on flow_nodes is filtered by flow_id: B's node
    // is still there, unedited.
    expect(
      h.db.rows('flow_nodes').find((n) => n.id === 'node-b')
    ).toBeDefined();
    expect(h.db.rows('flows').find((f) => f.id === 'flow-b')?.name).toBe(
      'flow b'
    );
    expectBUnchanged(before);
  });

  it("DELETE removes A's flow and no other account's", async () => {
    const before = h.db.snapshot(B);
    const res = await flowById.DELETE(
      req('DELETE', '/api/flows/flow-a'),
      params({ id: 'flow-a' })
    );
    expect(res.status).toBe(200);
    expect(h.db.rows('flows').map((f) => f.id)).toEqual(['flow-b']);
    expectBUnchanged(before);
  });

  it("activate validates and flips A's flow; B's stays active", async () => {
    const before = h.db.snapshot(B);
    const res = await flowActivate.POST(
      req('POST', '/api/flows/flow-a/activate', { status: 'active' }),
      params({ id: 'flow-a' })
    );
    const body = await res.json();
    // Both accounts have a node keyed 'start': had the node read not
    // been scoped to this flow, the validator would have seen a
    // duplicate node_key and refused with 422.
    expect(res.status).toBe(200);
    expect(body.flow.id).toBe('flow-a');
    expect(body.flow.status).toBe('active');
    expectNoBIds(body);

    const archived = await flowActivate.POST(
      req('POST', '/api/flows/flow-a/activate', { status: 'archived' }),
      params({ id: 'flow-a' })
    );
    expect(archived.status).toBe(200);
    expect(h.db.rows('flows').find((f) => f.id === 'flow-a')?.status).toBe(
      'archived'
    );
    expect(h.db.rows('flows').find((f) => f.id === 'flow-b')?.status).toBe(
      'active'
    );
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
    const res = await waConfig.GET(req('GET', '/api/whatsapp/config'));
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

  // Fase 4 §1: the per-number route. Its id comes straight out of the
  // URL, so it is the easiest place in the codebase to read or write
  // another tenant's row by guessing a UUID.
  it("GET lists only A's numbers", async () => {
    const res = await waConfig.GET(req('GET', '/api/whatsapp/config'));
    const body = await res.json();
    expect(body.numbers.map((n: { id: string }) => n.id)).toEqual(['cfg-a']);
    expectNoBIds(body);
  });

  it("PATCH on B's number → 404 and B is untouched", async () => {
    const before = h.db.snapshot(B);
    const res = await waConfigById.PATCH(
      req('PATCH', '/api/whatsapp/config/cfg-b', { label: 'stolen' }),
      params({ id: 'cfg-b' })
    );
    expect(res.status).toBe(404);
    expectBUnchanged(before);
  });

  it("DELETE on B's number → 404 and B still has it", async () => {
    const before = h.db.snapshot(B);
    const res = await waConfigById.DELETE(
      req('DELETE', '/api/whatsapp/config/cfg-b'),
      params({ id: 'cfg-b' })
    );
    expect(res.status).toBe(404);
    expectBUnchanged(before);
  });

  it("PATCH renames A's own number and leaves B's default alone", async () => {
    const before = h.db.snapshot(B);
    const res = await waConfigById.PATCH(
      req('PATCH', '/api/whatsapp/config/cfg-a', {
        label: 'Sales',
        is_default: true,
      }),
      params({ id: 'cfg-a' })
    );
    expect(res.status).toBe(200);
    const a = h.db.rows('whatsapp_config').find((r) => r.id === 'cfg-a');
    expect(a?.label).toBe('Sales');
    expect(a?.is_default).toBe(true);
    // The "clear the old default" half of the promotion is scoped by
    // account: B's number must still be B's default.
    expectBUnchanged(before);
  });

  it("DELETE ?id= on the collection route only removes A's row", async () => {
    const before = h.db.snapshot(B);
    const res = await waConfig.DELETE(
      req('DELETE', '/api/whatsapp/config?id=cfg-b')
    );
    expect(res.status).toBe(404);
    expectBUnchanged(before);
  });

  it('DELETE without an id refuses rather than wiping every number', async () => {
    const res = await waConfig.DELETE(req('DELETE', '/api/whatsapp/config'));
    expect(res.status).toBe(400);
    expect(h.db.rows('whatsapp_config')).toHaveLength(2);
  });
});

// ============================================================
// Registro integrado (fase 4 §1). Two reasons it belongs here: the
// ownership check runs with the service role (it HAS to — under RLS the
// caller cannot see another tenant's row), and everything the request
// names — the phone number, the WABA — is attacker-controlled.
// ============================================================

describe('/api/whatsapp/embedded-signup', () => {
  const ENV = ['META_APP_ID', 'META_CONFIG_ID'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.META_APP_ID = 'app-123';
    process.env.META_CONFIG_ID = 'cfgid-456';
    // The code exchange is the one Meta call that goes through global
    // fetch instead of `meta-api.ts`.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'fresh-token' }),
          }) as unknown as Response
      )
    );
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  const signup = (body: Record<string, unknown>) =>
    waEmbeddedSignup.POST(req('POST', '/api/whatsapp/embedded-signup', body));

  it("refuses to claim B's number and leaves B's row untouched", async () => {
    const before = h.db.snapshot(B);
    const res = await signup({
      code: 'the-code',
      phone_number_id: 'pn-b',
      waba_id: 'waba-b',
    });

    expect(res.status).toBe(409);
    // The code is single use: it must not be spent on a request that
    // cannot succeed.
    expect(fetch).not.toHaveBeenCalled();
    expect(h.meta.sends).toEqual([]);
    expectBUnchanged(before);
  });

  it("reconnects A's own number and writes only inside A", async () => {
    // A's seeded plan leaves no room for a SECOND number, so the shape
    // that exercises the write path end to end is a reconnection — which
    // is also the one the upsert of §1.7 exists for. What matters here
    // is where the write lands: the upsert keys on
    // (account_id, phone_number_id), and B's row carries the same
    // columns one account over.
    const before = h.db.snapshot(B);
    const res = await signup({
      code: 'the-code',
      phone_number_id: 'pn-a',
      waba_id: 'waba-a',
    });

    expect(res.status).toBe(200);
    const rows = h.db.rows('whatsapp_config');
    expect(rows.filter((r) => r.phone_number_id === 'pn-a')).toHaveLength(1);
    const updated = rows.find((r) => r.phone_number_id === 'pn-a');
    expect(updated?.account_id).toBe(A);
    expect(updated?.provisioned_via).toBe('embedded_signup');
    expectBUnchanged(before);
  });

  it("402s rather than letting A exceed its plan on B's back", async () => {
    const before = h.db.snapshot(B);
    const res = await signup({
      code: 'the-code',
      phone_number_id: 'pn-a-second',
      waba_id: 'waba-a',
    });

    // The count of "numbers already bound" must be A's own, not the
    // whole table: if it leaked B's row the number would be 2, and if it
    // ignored A's it would be 0 and the limit would never bite.
    expect(res.status).toBe(402);
    expect((await res.json()).metric).toBe('numbers');
    expectBUnchanged(before);
  });

  it('GET exposes the public ids and never the app secret', async () => {
    const res = await waEmbeddedSignup.GET();
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain(
      process.env.META_APP_SECRET as string
    );
    expectNoBIds(body);
  });
});

// ============================================================
// Template lifecycle. The rows go through the cookie-session client,
// but both routes hand `supabaseAdmin()` (storage + db) to
// `ensureImageHeaderHandle`, which reads the sample image straight out
// of the bucket. That is a service-role read of another tenant's
// attachment unless the ownership check holds.
// ============================================================

const storageUrl = (path: string, bucket = 'chat-media') =>
  `https://fake.supabase.co/storage/v1/object/public/${bucket}/${path}`;

/** Minimal valid payload; overrides carry whatever the test is about. */
function templatePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'promo',
    category: 'Marketing',
    language: 'en_US',
    body_text: 'Hello there',
    ...overrides,
  };
}

describe('/api/whatsapp/templates (service role in the header-handle path)', () => {
  it("PATCH on B's template → 404, nothing sent to Meta", async () => {
    const before = h.db.snapshot(B);
    const res = await waTemplateById.PATCH(
      req('PATCH', `/api/whatsapp/templates/${TPL_B}`, templatePayload()),
      params({ id: TPL_B })
    );
    expect(res.status).toBe(404);
    expect(h.meta.sends).toEqual([]);
    expectBUnchanged(before);
  });

  it('PATCH refuses a header image that belongs to B, before calling Meta', async () => {
    const before = h.db.snapshot(B);
    // A legacy `<uid>/…` object of B's: proving it is not A's takes a
    // service-role read of `profiles`, which must be account-scoped.
    h.db.storageObjects.push({
      bucket: 'chat-media',
      path: `${USER_B}/secret.png`,
    });
    const res = await waTemplateById.PATCH(
      req(
        'PATCH',
        `/api/whatsapp/templates/${TPL_A}`,
        templatePayload({
          header_type: 'image',
          header_media_url: storageUrl(`${USER_B}/secret.png`),
        })
      ),
      params({ id: TPL_A })
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/another account/);
    expect(h.meta.sends).toEqual([]);
    expectBUnchanged(before);
  });

  it("PATCH accepts A's own attachment and edits only A's row", async () => {
    const before = h.db.snapshot(B);
    h.db.storageObjects.push({
      bucket: 'chat-media',
      path: `${USER_A}/header.png`,
    });
    const res = await waTemplateById.PATCH(
      req(
        'PATCH',
        `/api/whatsapp/templates/${TPL_A}`,
        templatePayload({
          header_type: 'image',
          header_media_url: storageUrl(`${USER_A}/header.png`),
        })
      ),
      params({ id: TPL_A })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.template.id).toBe(TPL_A);
    expect(h.meta.sends.map((s) => s.fn)).toEqual([
      'uploadResumableMedia',
      'editMessageTemplate',
    ]);
    // Meta was told to edit A's template, not B's same-named one.
    expect(h.meta.sends[1].args.metaTemplateId).toBe('meta-tpl-a');
    const rows = h.db.rows('message_templates');
    expect(rows.find((t) => t.id === TPL_A)?.status).toBe('PENDING');
    expect(rows.find((t) => t.id === TPL_B)?.status).toBe('APPROVED');
    expectNoBIds(body);
    expectBUnchanged(before);
  });

  it("DELETE leaves B's template alone and removes A's", async () => {
    const before = h.db.snapshot(B);
    const foreign = await waTemplateById.DELETE(
      req('DELETE', `/api/whatsapp/templates/${TPL_B}`),
      params({ id: TPL_B })
    );
    expect(foreign.status).toBe(404);
    expect(h.meta.sends).toEqual([]);
    expectBUnchanged(before);

    const own = await waTemplateById.DELETE(
      req('DELETE', `/api/whatsapp/templates/${TPL_A}`),
      params({ id: TPL_A })
    );
    expect(own.status).toBe(200);
    expect(h.meta.sends.map((s) => s.args.metaTemplateId)).toEqual([
      'meta-tpl-a',
    ]);
    expect(h.db.rows('message_templates').map((t) => t.id)).toEqual([TPL_B]);
    expectBUnchanged(before);
  });

  it("submit refuses B's attachment and, with A's, submits under A", async () => {
    const before = h.db.snapshot(B);
    h.db.storageObjects.push({
      bucket: 'chat-media',
      path: `${USER_B}/secret.png`,
    });
    h.db.storageObjects.push({
      bucket: 'chat-media',
      path: `${USER_A}/header.png`,
    });

    const stolen = await waTemplateSubmit.POST(
      req(
        'POST',
        '/api/whatsapp/templates/submit',
        templatePayload({
          name: 'new_promo',
          header_type: 'image',
          header_media_url: storageUrl(`${USER_B}/secret.png`),
        })
      )
    );
    expect(stolen.status).toBe(400);
    expect((await stolen.json()).error).toMatch(/another account/);
    expect(h.meta.sends).toEqual([]);
    expectBUnchanged(before);

    const own = await waTemplateSubmit.POST(
      req(
        'POST',
        '/api/whatsapp/templates/submit',
        templatePayload({
          name: 'new_promo',
          header_type: 'image',
          header_media_url: storageUrl(`${USER_A}/header.png`),
        })
      )
    );
    const body = await own.json();
    expect(own.status).toBe(200);
    expect(body.template.account_id).toBe(A);
    expect(body.template.header_handle).toBe('HANDLE-1');
    expectNoBIds(body);
    expectBUnchanged(before);
  });
});

// ============================================================
// /api/platform — the operator's prefix and its support sessions.
//
// The actor here is USER_A, owner of account A. That is the shape the
// spec's criterion cares about: owning a company must buy you nothing at
// the platform level, and once an operator IS impersonating another
// company, nothing they do may land on account A by accident.
//
// The impersonated account is a third one, seeded here with a real uuid:
// `/api/platform/impersonate` validates `account_id` as a UUID before it
// goes near the database (a non-uuid against a `uuid` column is a cast
// error, not an empty result), and the suite's A/B fixtures predate that.
// ============================================================

const REASON = 'ticket 4321: the customer cannot see their broadcasts';
const TARGET = '33333333-3333-4333-8333-333333333333';
const USER_TARGET = '44444444-4444-4444-8444-444444444444';

function makePlatformAdmin(userId: string): void {
  h.db.rows('platform_admins').push({
    user_id: userId,
    granted_by: userId,
    granted_at: PAST,
    note: 'test',
  });
}

/** A third company for the operator to look at. */
function seedTargetAccount(): void {
  h.db.rows('accounts').push({
    id: TARGET,
    name: 'Company T',
    owner_user_id: USER_TARGET,
  });
  h.db.rows('profiles').push({
    id: 'profile-t',
    user_id: USER_TARGET,
    account_id: TARGET,
    account_role: 'owner',
    full_name: 'Owner T',
  });
}

describe('/api/platform (support sessions, service role)', () => {
  it('403s the owner of account A, who is not in platform_admins', async () => {
    // Nothing about account B — not its name, not its id — comes back,
    // and no bitácora row appears.
    const before = h.db.snapshot(B);

    const res = await platformImpersonate.POST(
      req('POST', '/api/platform/impersonate', {
        account_id: B,
        reason: REASON,
      })
    );

    expect(res.status).toBe(403);
    expectNoBIds(await res.json());
    expect(h.db.rows('impersonation_log')).toEqual([]);
    expectBUnchanged(before);
  });

  it('403s on GET and on stop as well — the whole prefix is closed', async () => {
    expect((await platformImpersonate.GET()).status).toBe(403);
    expect((await platformImpersonateStop.POST()).status).toBe(403);
  });

  it("records the session under the impersonated account, never the actor's own", async () => {
    makePlatformAdmin(USER_A);
    seedTargetAccount();

    const res = await platformImpersonate.POST(
      req('POST', '/api/platform/impersonate', {
        account_id: TARGET,
        reason: REASON,
      })
    );
    expect(res.status).toBe(200);

    const rows = h.db.rows('impersonation_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: USER_A,
      account_id: TARGET,
      reason: REASON,
    });
    // If the route had written the row under the actor's own account, the
    // audit would point at the wrong company for the rest of time.
    expect(rows[0].account_id).not.toBe(A);
  });

  it('moves nothing of either seeded company while opening and closing a session', async () => {
    makePlatformAdmin(USER_A);
    seedTargetAccount();
    const beforeA = h.db.snapshot(A);
    const beforeB = h.db.snapshot(B);

    await platformImpersonate.POST(
      req('POST', '/api/platform/impersonate', {
        account_id: TARGET,
        reason: REASON,
      })
    );
    await platformImpersonateStop.POST();

    expect(h.db.snapshot(A)).toEqual(beforeA);
    expect(h.db.snapshot(B)).toEqual(beforeB);
    expect(h.db.rows('impersonation_log')[0].ended_reason).toBe('manual');
  });

  it('404s an account that does not exist, without opening a session', async () => {
    makePlatformAdmin(USER_A);
    const res = await platformImpersonate.POST(
      req('POST', '/api/platform/impersonate', {
        account_id: 'dddddddd-0000-4000-8000-00000000dead',
        reason: REASON,
      })
    );
    expect(res.status).toBe(404);
    expect(h.db.rows('impersonation_log')).toEqual([]);
  });

  it('resolves the account context to the impersonated company, read-only', async () => {
    makePlatformAdmin(USER_A);
    seedTargetAccount();
    const beforeA = h.db.snapshot(A);

    await platformImpersonate.POST(
      req('POST', '/api/platform/impersonate', {
        account_id: TARGET,
        reason: REASON,
      })
    );

    // Every route in the app resolves its account through this. During a
    // support session it names the company being looked at — and hands
    // out `viewer`, whatever the operator is in their own company (owner).
    const ctx = await getCurrentAccount();
    expect(ctx.accountId).toBe(TARGET);
    expect(ctx.account.name).toBe('Company T');
    expect(ctx.role).toBe('viewer');
    expect(ctx.impersonation?.accountId).toBe(TARGET);

    // So a route that asks for a write-level role refuses…
    const write = await quickReplies.POST(
      req('POST', '/api/quick-replies', {
        title: 'from a support session',
        content_text: 'should never be stored',
      })
    );
    expect(write.status).toBe(403);

    // …and in particular it did not write into the operator's OWN company,
    // which is the failure mode that makes impersonation dangerous.
    expect(h.db.snapshot(A)).toEqual(beforeA);
    expect(
      h.db.rows('quick_replies').filter((r) => r.account_id === TARGET)
    ).toEqual([]);
  });

  it('reports the open session, and reports none once it is stopped', async () => {
    makePlatformAdmin(USER_A);
    seedTargetAccount();
    await platformImpersonate.POST(
      req('POST', '/api/platform/impersonate', {
        account_id: TARGET,
        reason: REASON,
      })
    );

    const open = await (await platformImpersonate.GET()).json();
    expect(open.session).toMatchObject({ account_id: TARGET });

    await platformImpersonateStop.POST();
    const closed = await (await platformImpersonate.GET()).json();
    expect(closed.session).toBeNull();
  });
});

// ============================================================
// /api/platform/accounts — the panel of fase 4 §2, against the same two
// seeded companies.
//
// This is where the acceptance criterion is graded: «un administrador de
// plataforma ve todas las cuentas; un `owner` normal no ve más que la
// suya». The actor is USER_A, owner of A, and the answer has to be that
// he sees none of this at all — not a filtered view, not his own row.
// ============================================================

describe('/api/platform/accounts (the panel, service role)', () => {
  const HOLD_REASON = 'chargebacks on three invoices, ticket 88';

  function holdReq(accountId: string, body: unknown) {
    return platformAccountHold.POST(
      req('POST', `/api/platform/accounts/${accountId}/hold`, body),
      { params: Promise.resolve({ id: accountId }) }
    );
  }

  function detailReq(accountId: string) {
    return platformAccountById.GET(
      req('GET', `/api/platform/accounts/${accountId}`),
      { params: Promise.resolve({ id: accountId }) }
    );
  }

  /**
   * The company the operator acts ON, with a subscription of its own.
   *
   * It is `TARGET` rather than B for the same reason the impersonation
   * block uses it: `/api/platform/accounts/[id]` validates the id as a
   * UUID before going near the database (a non-uuid against a `uuid`
   * column is a cast error, not an empty result) and the suite's A/B
   * fixtures are `acct-a` / `acct-b`. What the isolation tests need from
   * the second company is that it is NOT A — and A keeps all its
   * fixtures, which is the side that has to survive untouched.
   */
  function seedTargetWithSubscription() {
    seedTargetAccount();
    h.db.rows('subscriptions').push({
      account_id: TARGET,
      plan_id: 'pro',
      status: 'active',
      provider: 'paypal',
      provider_subscription_id: null,
      current_period_end: null,
      grace_until: null,
      trial_ends_at: null,
      cancel_at_period_end: false,
      cycle: 'month',
      manual_hold_at: null,
      manual_hold_by: null,
      manual_hold_reason: null,
    });
  }

  it('403s the owner of A on the census, and tells him nothing about B', async () => {
    const before = h.db.snapshot(B);

    const res = await platformAccounts.GET(
      req('GET', '/api/platform/accounts')
    );

    expect(res.status).toBe(403);
    expectNoBIds(await res.json());
    expectBUnchanged(before);
  });

  it("403s the owner of A on B's file — and on his OWN account's file too", async () => {
    expect((await detailReq(B)).status).toBe(403);
    // The panel is not a second door into your own data either: a tenant
    // reads their own subscription through /api/billing/*, with a role
    // check and without the gateway payloads.
    expect((await detailReq(A)).status).toBe(403);
  });

  it('403s the owner of A trying to suspend anybody, including himself', async () => {
    const before = h.db.snapshot(B);

    expect(
      (await holdReq(B, { action: 'suspend', reason: HOLD_REASON })).status
    ).toBe(403);
    expect(
      (await holdReq(A, { action: 'suspend', reason: HOLD_REASON })).status
    ).toBe(403);

    // Neither company moved, and nothing was written to the bitácora.
    expectBUnchanged(before);
    expect(h.db.rows('impersonation_log')).toEqual([]);
    for (const row of h.db.rows('subscriptions')) {
      expect(row.manual_hold_at ?? null).toBeNull();
    }
  });

  it('gives a platform admin every account, and the owner of A none', async () => {
    makePlatformAdmin(USER_A);

    const res = await platformAccounts.GET(
      req('GET', '/api/platform/accounts')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.accounts.map((row: Row) => row.accountId);
    // Both halves of the criterion in one assertion: the operator sees
    // A and B, and the test above showed the same user, without the
    // platform_admins row, saw neither.
    expect(new Set(ids)).toEqual(new Set([A, B]));
  });

  it("lets a platform admin read another company's file without touching A's", async () => {
    makePlatformAdmin(USER_A);
    seedTargetWithSubscription();
    const beforeA = h.db.snapshot(A);
    const beforeB = h.db.snapshot(B);

    const res = await detailReq(TARGET);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.accountId).toBe(TARGET);
    expect(body.name).toBe('Company T');
    // The members are the target's, and neither of the other two
    // companies appears anywhere in the body.
    expect(body.members.map((m: Row) => m.userId)).toEqual([USER_TARGET]);
    expect(stringsIn(body).filter((value) => h.db.idsOf(A).has(value))).toEqual(
      []
    );
    expectNoBIds(body);
    expect(h.db.snapshot(A)).toEqual(beforeA);
    expectBUnchanged(beforeB);
  });

  it('suspends one company by hand: A and B do not move, and it is on the record', async () => {
    makePlatformAdmin(USER_A);
    seedTargetWithSubscription();
    const beforeA = h.db.snapshot(A);
    const beforeB = h.db.snapshot(B);

    const res = await holdReq(TARGET, {
      action: 'suspend',
      reason: HOLD_REASON,
    });
    expect(res.status).toBe(200);

    const held = h.db
      .rows('subscriptions')
      .find((row) => row.account_id === TARGET)!;
    expect(held.manual_hold_at).toBeTruthy();
    expect(held.manual_hold_reason).toBe(HOLD_REASON);
    expect(held.manual_hold_by).toBe(USER_A);
    // `status` is untouched: it belongs to the PayPal webhook, and a hold
    // stored there would be lifted by the next payment event.
    expect(held.status).toBe('active');

    // The other two are exactly as they were — this is the write that
    // could most easily land on the wrong company.
    expect(h.db.snapshot(A)).toEqual(beforeA);
    expectBUnchanged(beforeB);
    for (const row of h.db.rows('subscriptions')) {
      if (row.account_id === TARGET) continue;
      expect(row.manual_hold_at ?? null).toBeNull();
    }

    // And the bitácora of f4.4 has the four things the spec names.
    const trail = h.db.rows('impersonation_log');
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'suspend',
      actor_user_id: USER_A,
      account_id: TARGET,
      reason: HOLD_REASON,
    });
  });

  it('reactivating clears the hold, and only on the company it names', async () => {
    makePlatformAdmin(USER_A);
    seedTargetWithSubscription();
    await holdReq(TARGET, { action: 'suspend', reason: HOLD_REASON });
    const beforeA = h.db.snapshot(A);
    const beforeB = h.db.snapshot(B);

    const res = await holdReq(TARGET, {
      action: 'reactivate',
      reason: 'refunded, ticket 88 closed',
    });
    expect(res.status).toBe(200);

    const freed = h.db
      .rows('subscriptions')
      .find((row) => row.account_id === TARGET)!;
    expect(freed.manual_hold_at).toBeNull();
    expect(freed.manual_hold_by).toBeNull();
    expect(freed.manual_hold_reason).toBeNull();
    expect(h.db.snapshot(A)).toEqual(beforeA);
    expectBUnchanged(beforeB);
    // Two lines in the trail: suspending and lifting are both acts.
    expect(h.db.rows('impersonation_log')).toHaveLength(2);
  });
});

// ============================================================
// Plantillas por la API pública (fase 7 §3). Bloque al final del archivo
// a propósito: la otra mitad de la fase edita este mismo test en
// paralelo y así los dos añadidos no se pisan.
//
// Las dos cuentas tienen una plantilla que se llama `promo` en `en_US`,
// que es justo el par que la tabla hace único POR CUENTA: cualquier
// consulta a la que se le caiga el `account_id` casa con la de B, que
// está sembrada primero.
// ============================================================

describe('/api/v1/templates (service role via API key)', () => {
  /** El catálogo que devolvería Meta, por `global.fetch`. */
  function metaCatalog(templates: Record<string, unknown>[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ data: templates }),
          }) as unknown as Response
      )
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /templates lists A's and never B's same-named one", async () => {
    const res = await v1Templates.GET(
      req('GET', '/api/v1/templates?search=promo', undefined, asKeyA)
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.map((t: Row) => t.id)).toEqual([TPL_A]);
    expectNoBIds(body);
    // Ni el cuerpo de B, que lleva su etiqueta dentro del texto.
    expect(JSON.stringify(body)).not.toContain('from b');
  });

  it("GET/PATCH/DELETE on B's template id are 404 and touch neither B nor Meta", async () => {
    const before = h.db.snapshot(B);

    const got = await v1TemplateById.GET(
      req('GET', `/api/v1/templates/${TPL_B}`, undefined, asKeyA),
      params({ id: TPL_B })
    );
    expect(got.status).toBe(404);

    const patched = await v1TemplateById.PATCH(
      req(
        'PATCH',
        `/api/v1/templates/${TPL_B}`,
        { body_text: 'pwned {{1}}', sample_values: { body: ['x'] } },
        asKeyA
      ),
      params({ id: TPL_B })
    );
    expect(patched.status).toBe(404);

    const deleted = await v1TemplateById.DELETE(
      req('DELETE', `/api/v1/templates/${TPL_B}`, undefined, asKeyA),
      params({ id: TPL_B })
    );
    expect(deleted.status).toBe(404);

    expect(h.meta.sends).toEqual([]);
    expectBUnchanged(before);

    // Y la propia sí se lee, para que el 404 anterior no sea un falso
    // verde de una ruta rota.
    const own = await v1TemplateById.GET(
      req('GET', `/api/v1/templates/${TPL_A}`, undefined, asKeyA),
      params({ id: TPL_A })
    );
    expect(own.status).toBe(200);
  });

  it("POST /templates submits under A's WABA even when B has the same name", async () => {
    const before = h.db.snapshot(B);
    const res = await v1Templates.POST(
      req(
        'POST',
        '/api/v1/templates',
        {
          name: 'welcome_back',
          language: 'en_US',
          category: 'Marketing',
          body_text: 'Welcome {{1}}',
          sample_values: { body: ['Ada'] },
        },
        asKeyA
      )
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(h.meta.sends.map((s) => s.fn)).toEqual(['submitMessageTemplate']);
    expect(h.meta.sends[0].args.wabaId).toBe('waba-a');

    const row = h.db
      .rows('message_templates')
      .find((t) => t.name === 'welcome_back')!;
    expect(row.account_id).toBe(A);
    expectNoBIds(body);
    expectBUnchanged(before);
  });

  it("POST /templates/sync rewrites A's catalogue only", async () => {
    const before = h.db.snapshot(B);
    // Meta devuelve la MISMA (name, language) que las dos cuentas tienen.
    metaCatalog([
      {
        id: 'meta-tpl-a',
        name: 'promo',
        language: 'en_US',
        status: 'PAUSED',
        category: 'MARKETING',
        components: [{ type: 'BODY', text: 'Hello {{1}} from meta' }],
      },
    ]);

    const res = await v1TemplatesSync.POST(
      req('POST', '/api/v1/templates/sync', undefined, asKeyA)
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ synced: 1, created: 0, updated: 1 });
    // El cambio de estado se emitió, y bajo la cuenta de la clave.
    expect(h.webhookEvents).toEqual([
      { accountId: A, event: 'template.status_updated' },
    ]);
    expect(body.data.status_changes[0].template_id).toBe(TPL_A);
    expectNoBIds(body);
    expectBUnchanged(before);
  });
});
