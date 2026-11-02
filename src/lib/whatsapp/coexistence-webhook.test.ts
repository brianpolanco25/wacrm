import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';
import { encrypt } from './encryption';
import { describeDbError } from './inbound-thread';

// Forbidden side effects (requirements glossary): mocked so any call is
// visible. The code under test must not even import them.
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(),
}));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('@/lib/billing/enforce', () => ({
  assertWritable: vi.fn(),
  assertQuota: vi.fn(),
  assertPlanFeature: vi.fn(),
  getEntitlements: vi.fn(),
  recordUsage: vi.fn(),
}));
vi.mock('@/lib/whatsapp/message-charges', () => ({
  recordMessageCharge: vi.fn(),
  parseStatusPricing: vi.fn(),
}));
vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: vi.fn(),
}));

import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import * as enforce from '@/lib/billing/enforce';
import { recordMessageCharge } from '@/lib/whatsapp/message-charges';
import { reopenClosedConversation } from '@/lib/conversations/reopen';

import {
  COEXISTENCE_FIELDS,
  DELETED_MARKER,
  contentTextFor,
  handleAccountUpdate,
  handleCoexistenceChange,
  isCoexistenceField,
  mapHistoryStatus,
  parseHistoryItems,
  parseHistoryThread,
  parseMessageEchoes,
  parseStateSyncItem,
  storeThreadMessages,
  type CoexistenceConfig,
  type CoexistenceMessage,
} from './coexistence-webhook';

const A = 'acct-a';
const BUSINESS = '18295479000';
const CUSTOMER = '18095551234';
const SECRET_BODY = 'secreto del cliente 7731';
const SECRET_CAPTION = 'foto privada 9921';
const SECRET_NAME = 'Ana Pérez Confidencial';

const config: CoexistenceConfig = {
  id: 'cfg-a',
  account_id: A,
  user_id: 'user-a',
  phone_number_id: 'pn-a',
  display_phone_number: BUSINESS,
};

function seed(extra: Partial<Record<string, Row[]>> = {}): FakeDatabase {
  return new FakeDatabase({
    accounts: [{ id: A, name: 'A' }],
    whatsapp_config: [
      {
        id: 'cfg-a',
        account_id: A,
        user_id: 'user-a',
        phone_number_id: 'pn-a',
        waba_id: 'waba-a',
        status: 'connected',
      },
    ],
    contacts: [
      {
        id: 'contact-1',
        account_id: A,
        user_id: 'user-a',
        phone: '+18095551234',
        name: 'Cliente Uno',
      },
    ],
    conversations: [
      {
        id: 'conv-1',
        account_id: A,
        user_id: 'user-a',
        contact_id: 'contact-1',
        whatsapp_config_id: 'cfg-a',
        status: 'closed',
        unread_count: 3,
        last_message_text: 'previo',
        last_message_at: '2025-11-01T00:00:00.000Z',
        created_at: '2025-10-01T00:00:00.000Z',
      },
    ],
    messages: [
      {
        id: 'msg-orig',
        conversation_id: 'conv-1',
        sender_type: 'agent',
        content_type: 'text',
        content_text: 'texto original',
        message_id: 'wamid.ORIG',
        status: 'sent',
        created_at: '2025-11-01T00:00:00.000Z',
      },
    ],
    ...extra,
  });
}

const asDb = (db: FakeDatabase) => db.admin as unknown as SupabaseClient;
const ts = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));

function echoValue(echoes: Record<string, unknown>[]) {
  return {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: BUSINESS, phone_number_id: 'pn-a' },
    message_echoes: echoes,
  };
}

function textEcho(id: string, to = CUSTOMER, iso = '2026-11-02T10:00:00Z') {
  return {
    from: BUSINESS,
    to,
    id,
    timestamp: ts(iso),
    type: 'text',
    text: { body: SECRET_BODY },
  };
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

function expectNoForbiddenSideEffects(db?: FakeDatabase) {
  expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  expect(dispatchInboundToFlows).not.toHaveBeenCalled();
  expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
  expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  expect(recordMessageCharge).not.toHaveBeenCalled();
  expect(reopenClosedConversation).not.toHaveBeenCalled();
  for (const fn of Object.values(enforce)) {
    if (typeof fn === 'function' && 'mock' in fn) {
      expect(fn).not.toHaveBeenCalled();
    }
  }
  if (db) expect(db.log.filter((l) => l.op === 'rpc')).toEqual([]);
}

function expectLogsClean(...secrets: string[]) {
  const all = logs.join('\n');
  for (const s of secrets) expect(all).not.toContain(s);
}

// ------------------------------------------------------------------

describe('parsers', () => {
  it('recognises the three coexistence fields only', () => {
    for (const f of COEXISTENCE_FIELDS)
      expect(isCoexistenceField(f)).toBe(true);
    expect(isCoexistenceField('messages')).toBe(false);
    expect(isCoexistenceField('account_update')).toBe(false);
    expect(isCoexistenceField(42)).toBe(false);
  });

  it('echo text, image with caption, video and document → content_text', () => {
    const { echoes } = parseMessageEchoes(
      echoValue([
        textEcho('w1'),
        {
          to: CUSTOMER,
          id: 'w2',
          timestamp: '1762100000',
          type: 'image',
          image: { caption: 'hola', mime_type: 'image/jpeg', id: 'm' },
        },
        {
          to: CUSTOMER,
          id: 'w3',
          timestamp: '1762100000',
          type: 'video',
          video: {},
        },
        { to: CUSTOMER, id: 'w4', timestamp: '1762100000', type: 'document' },
      ])
    );
    expect(
      echoes.map((e) => (e.kind === 'message' ? e.message.contentText : null))
    ).toEqual([SECRET_BODY, '[image] hola', '[video]', '[document]']);
    const first = echoes[0];
    expect(first.kind === 'message' && first.message).toMatchObject({
      wamid: 'w1',
      senderType: 'agent',
      status: 'sent',
      createdAt: '2026-11-02T10:00:00.000Z',
    });
    expect(first.phone).toBe(CUSTOMER);
  });

  it('echo revoke and edit (text and image) → originalId', () => {
    const { echoes } = parseMessageEchoes(
      echoValue([
        {
          to: CUSTOMER,
          id: 'w5',
          type: 'revoke',
          revoke: { original_message_id: 'wamid.ORIG' },
        },
        {
          to: CUSTOMER,
          id: 'w6',
          type: 'edit',
          edit: {
            original_message_id: 'wamid.ORIG',
            message: { type: 'text', text: { body: 'corregido' } },
          },
        },
        {
          to: CUSTOMER,
          id: 'w7',
          type: 'edit',
          edit: {
            original_message_id: 'wamid.IMG',
            message: { type: 'image', image: { caption: 'nueva' } },
          },
        },
      ])
    );
    expect(echoes).toEqual([
      {
        kind: 'revoke',
        phone: CUSTOMER,
        wamid: 'w5',
        originalId: 'wamid.ORIG',
      },
      {
        kind: 'edit',
        phone: CUSTOMER,
        wamid: 'w6',
        originalId: 'wamid.ORIG',
        contentText: 'corregido',
      },
      {
        kind: 'edit',
        phone: CUSTOMER,
        wamid: 'w7',
        originalId: 'wamid.IMG',
        contentText: '[image] nueva',
      },
    ]);
  });

  it('echo without `to` or with fewer than 7 digits → skipped; unknown type → marker', () => {
    const { echoes, skipped } = parseMessageEchoes(
      echoValue([
        { id: 'w8', type: 'text', text: { body: 'x' } },
        { id: 'w9', to: '12345', type: 'text', text: { body: 'x' } },
        { id: 'w10', to: CUSTOMER, type: 'sticker', sticker: {} },
      ])
    );
    expect(skipped).toEqual(['w8', 'w9']);
    expect(echoes).toHaveLength(1);
    expect(echoes[0].kind === 'message' && echoes[0].message.contentText).toBe(
      '[sticker]'
    );
  });

  it('history thread: ascending order, direction by `to` and by business `from`', () => {
    const parsed = parseHistoryThread(
      {
        id: CUSTOMER,
        messages: [
          {
            from: BUSINESS,
            id: 'h3',
            timestamp: '1760000300',
            type: 'text',
            text: { body: 'c' },
          },
          {
            from: CUSTOMER,
            id: 'h1',
            timestamp: '1760000100',
            type: 'text',
            text: { body: 'a' },
            history_context: { status: 'READ' },
          },
          {
            from: '+1 829 547 9000',
            to: CUSTOMER,
            id: 'h2',
            timestamp: '1760000200',
            type: 'media_placeholder',
            history_context: { status: 'DELIVERED' },
          },
        ],
      },
      BUSINESS
    );
    expect(parsed?.phone).toBe(CUSTOMER);
    expect(
      parsed?.messages.map((m) => [m.wamid, m.senderType, m.status])
    ).toEqual([
      ['h1', 'customer', 'read'],
      ['h2', 'agent', 'delivered'],
      ['h3', 'agent', 'sent'],
    ]);
    expect(parsed?.messages[1].contentText).toBe('[media]');
  });

  it('maps history_context.status, with defaults by direction', () => {
    expect(mapHistoryStatus('SENT', 'agent')).toBe('sent');
    expect(mapHistoryStatus('DELIVERED', 'agent')).toBe('delivered');
    expect(mapHistoryStatus('READ', 'customer')).toBe('read');
    expect(mapHistoryStatus('PLAYED', 'customer')).toBe('read');
    expect(mapHistoryStatus('PENDING', 'agent')).toBe('sending');
    expect(mapHistoryStatus('ERROR', 'agent')).toBe('failed');
    expect(mapHistoryStatus(undefined, 'customer')).toBe('delivered');
    expect(mapHistoryStatus('WEIRD', 'agent')).toBe('sent');
  });

  it('content markers: media_placeholder, caption, missing type', () => {
    expect(contentTextFor({ type: 'media_placeholder' })).toBe('[media]');
    expect(contentTextFor({ type: 'audio', audio: {} })).toBe('[audio]');
    expect(contentTextFor({})).toBe('[unknown]');
  });

  it('history items: errors 2593109 and other codes are separated', () => {
    const { items, errorCodes } = parseHistoryItems({
      history: [
        { errors: [{ code: 2593109, title: 't' }] },
        {
          metadata: { phase: 1, chunk_order: '4', progress: 30 },
          threads: [{ id: CUSTOMER, messages: [] }],
        },
        { errors: [{ code: 131000 }] },
      ],
    });
    expect(errorCodes).toEqual([2593109, 131000]);
    expect(items).toEqual([
      {
        phase: 1,
        chunkOrder: 4,
        progress: 30,
        threads: [{ id: CUSTOMER, messages: [] }],
      },
    ]);
  });

  it('state sync: add with full_name, only first_name, no name; remove; ignored; invalid', () => {
    const add = (contact: Record<string, unknown>) => ({
      type: 'contact',
      action: 'add',
      contact,
    });
    expect(
      parseStateSyncItem(add({ full_name: 'Ana P', phone_number: CUSTOMER }))
    ).toEqual({ action: 'add', phone: CUSTOMER, name: 'Ana P' });
    expect(
      parseStateSyncItem(add({ first_name: 'Ana', phone_number: CUSTOMER }))
    ).toEqual({ action: 'add', phone: CUSTOMER, name: 'Ana' });
    expect(parseStateSyncItem(add({ phone_number: CUSTOMER }))).toEqual({
      action: 'add',
      phone: CUSTOMER,
      name: null,
    });
    expect(
      parseStateSyncItem({
        type: 'contact',
        action: 'remove',
        contact: { phone_number: CUSTOMER },
      })
    ).toEqual({ action: 'remove', phone: CUSTOMER, name: null });
    expect(parseStateSyncItem({ type: 'label', action: 'add' })).toBe(
      'ignored'
    );
    expect(parseStateSyncItem(add({ phone_number: '123' }))).toBe('invalid');
  });

  it('non-object or missing values never throw', () => {
    for (const v of [null, undefined, 42, 'x', [], { message_echoes: 'x' }]) {
      expect(() => parseMessageEchoes(v)).not.toThrow();
      expect(() => parseHistoryItems(v)).not.toThrow();
      expect(() => parseHistoryThread(v, BUSINESS)).not.toThrow();
      expect(() => parseStateSyncItem(v)).not.toThrow();
      expect(() => contentTextFor(v as Record<string, unknown>)).not.toThrow();
    }
    expect(parseMessageEchoes(null)).toEqual({ echoes: [], skipped: [] });
    expect(parseHistoryThread(null, BUSINESS)).toBeNull();
    expect(parseStateSyncItem(null)).toBe('invalid');
  });
});

// ------------------------------------------------------------------

describe('storeThreadMessages', () => {
  const msg = (
    wamid: string,
    iso: string,
    senderType: 'customer' | 'agent' = 'customer'
  ): CoexistenceMessage => ({
    wamid,
    createdAt: new Date(iso).toISOString(),
    senderType,
    status: senderType === 'agent' ? 'sent' : 'read',
    contentText: `t-${wamid}`,
  });

  it('inserts with the original sender, status and date; a repeat inserts nothing', async () => {
    const db = seed();
    const first = await storeThreadMessages(asDb(db), config, CUSTOMER, [
      msg('a', '2025-10-05T00:00:00Z'),
      msg('b', '2025-10-06T00:00:00Z', 'agent'),
    ]);
    expect(first).toEqual({ inserted: 2 });
    const rows = db
      .rows('messages')
      .filter((m) => m.conversation_id === 'conv-1');
    expect(rows.find((r) => r.message_id === 'a')).toMatchObject({
      sender_type: 'customer',
      sender_id: null,
      status: 'read',
      content_type: 'text',
      media_url: null,
      created_at: '2025-10-05T00:00:00.000Z',
    });
    expect(rows.find((r) => r.message_id === 'b')?.sender_type).toBe('agent');

    const second = await storeThreadMessages(asDb(db), config, CUSTOMER, [
      msg('a', '2025-10-05T00:00:00Z'),
      msg('b', '2025-10-06T00:00:00Z', 'agent'),
    ]);
    expect(second).toEqual({ inserted: 0 });
    expect(db.rows('messages')).toHaveLength(3);
    expectNoForbiddenSideEffects(db);
  });

  it('1 200 messages go in three upserts', async () => {
    const db = seed();
    const many = Array.from({ length: 1200 }, (_, i) =>
      msg(`m${i}`, new Date(Date.UTC(2025, 0, 1) + i * 1000).toISOString())
    );
    const out = await storeThreadMessages(asDb(db), config, CUSTOMER, many);
    expect(out).toEqual({ inserted: 1200 });
    expect(
      db.log.filter((l) => l.table === 'messages' && l.op === 'upsert')
    ).toHaveLength(3);
  });

  it('last_message_* never goes back, moves forward, and unread/status stay', async () => {
    const db = seed();
    await storeThreadMessages(asDb(db), config, CUSTOMER, [
      msg('old', '2025-01-01T00:00:00Z'),
    ]);
    let conv = db.rows('conversations')[0];
    expect(conv.last_message_text).toBe('previo');
    expect(conv.last_message_at).toBe('2025-11-01T00:00:00.000Z');

    await storeThreadMessages(asDb(db), config, CUSTOMER, [
      msg('new1', '2026-01-01T00:00:00Z'),
      msg('new2', '2026-02-01T00:00:00Z'),
    ]);
    conv = db.rows('conversations')[0];
    expect(conv.last_message_text).toBe('t-new2');
    expect(conv.last_message_at).toBe('2026-02-01T00:00:00.000Z');
    expect(conv.unread_count).toBe(3);
    expect(conv.status).toBe('closed');
    const update = db.log.find(
      (l) => l.table === 'conversations' && l.op === 'update'
    );
    expect(update?.filters).toContainEqual({
      column: 'account_id',
      op: 'eq',
      value: A,
    });
    expectNoForbiddenSideEffects(db);
  });
});

// ------------------------------------------------------------------

describe('echoes', () => {
  it('existing recipient in another format → same contact and conversation, name intact', async () => {
    const db = seed();
    await handleCoexistenceChange(
      asDb(db),
      'smb_message_echoes',
      echoValue([textEcho('wamid.E1', CUSTOMER, '2026-11-02T10:00:00Z')]),
      config
    );
    expect(db.rows('contacts')).toHaveLength(1);
    expect(db.rows('contacts')[0].name).toBe('Cliente Uno');
    expect(db.rows('conversations')).toHaveLength(1);
    const row = db.rows('messages').find((m) => m.message_id === 'wamid.E1');
    expect(row).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      sender_id: null,
      status: 'sent',
      content_text: SECRET_BODY,
      created_at: '2026-11-02T10:00:00.000Z',
    });
    const conv = db.rows('conversations')[0];
    expect(conv.last_message_at).toBe('2026-11-02T10:00:00.000Z');
    expect(conv.unread_count).toBe(3);
    expect(conv.status).toBe('closed');
    expectNoForbiddenSideEffects(db);
    expectLogsClean(SECRET_BODY, CUSTOMER);
  });

  it('new recipient → one contact and one conversation', async () => {
    const db = seed();
    await handleCoexistenceChange(
      asDb(db),
      'smb_message_echoes',
      echoValue([textEcho('wamid.E2', '18095550000')]),
      config
    );
    const created = db.rows('contacts').filter((c) => c.id !== 'contact-1');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      account_id: A,
      phone: '18095550000',
      name: '18095550000',
    });
    const convs = db.rows('conversations').filter((c) => c.id !== 'conv-1');
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({
      account_id: A,
      contact_id: created[0].id,
      whatsapp_config_id: 'cfg-a',
    });
    expectNoForbiddenSideEffects(db);
    expectLogsClean('18095550000', SECRET_BODY);
  });

  it('the same echo twice → a single row', async () => {
    const db = seed();
    for (let i = 0; i < 2; i++) {
      await handleCoexistenceChange(
        asDb(db),
        'smb_message_echoes',
        echoValue([textEcho('wamid.E3')]),
        config
      );
    }
    expect(
      db.rows('messages').filter((m) => m.message_id === 'wamid.E3')
    ).toHaveLength(1);
  });

  it('revoke → original says [deleted], no new row, summary untouched', async () => {
    const db = seed();
    const before = { ...db.rows('conversations')[0] };
    await handleCoexistenceChange(
      asDb(db),
      'smb_message_echoes',
      echoValue([
        {
          to: CUSTOMER,
          id: 'wamid.R1',
          timestamp: '1762100000',
          type: 'revoke',
          revoke: { original_message_id: 'wamid.ORIG' },
        },
      ]),
      config
    );
    expect(db.rows('messages')).toHaveLength(1);
    expect(db.rows('messages')[0].content_text).toBe(DELETED_MARKER);
    expect(db.rows('conversations')[0]).toEqual(before);
    const upd = db.log.find((l) => l.table === 'messages' && l.op === 'update');
    expect(upd?.filters).toContainEqual({
      column: 'conversation_id',
      op: 'eq',
      value: 'conv-1',
    });
    expectNoForbiddenSideEffects(db);
  });

  it('edit → original gets the new content', async () => {
    const db = seed();
    await handleCoexistenceChange(
      asDb(db),
      'smb_message_echoes',
      echoValue([
        {
          to: CUSTOMER,
          id: 'wamid.ED1',
          type: 'edit',
          edit: {
            original_message_id: 'wamid.ORIG',
            message: { type: 'image', image: { caption: SECRET_CAPTION } },
          },
        },
      ]),
      config
    );
    expect(db.rows('messages')).toHaveLength(1);
    expect(db.rows('messages')[0].content_text).toBe(
      `[image] ${SECRET_CAPTION}`
    );
    expectLogsClean(SECRET_CAPTION, CUSTOMER);
  });

  it('revoke/edit of a missing original or contact → logged, nothing created', async () => {
    const db = seed();
    await handleCoexistenceChange(
      asDb(db),
      'smb_message_echoes',
      echoValue([
        {
          to: CUSTOMER,
          id: 'wamid.R2',
          type: 'revoke',
          revoke: { original_message_id: 'wamid.NOPE' },
        },
        {
          to: '18095559999',
          id: 'wamid.R3',
          type: 'edit',
          edit: {
            original_message_id: 'wamid.ORIG',
            message: { type: 'text', text: { body: SECRET_BODY } },
          },
        },
      ]),
      config
    );
    expect(db.rows('contacts')).toHaveLength(1);
    expect(db.rows('conversations')).toHaveLength(1);
    expect(db.rows('messages')[0].content_text).toBe('texto original');
    const notFound = logs.filter((l) => l.includes('echo target not found'));
    expect(notFound).toHaveLength(2);
    expect(notFound[0]).toContain('wamid.R2');
    expect(notFound[0]).toContain('wamid.NOPE');
    expect(notFound[1]).toContain('"type":"edit"');
    expectLogsClean(SECRET_BODY, '18095559999');
  });

  it('echo without recipient → logged by wamid and the rest of the batch goes on', async () => {
    const db = seed();
    await handleCoexistenceChange(
      asDb(db),
      'smb_message_echoes',
      echoValue([
        { id: 'wamid.NOTO', type: 'text', text: { body: SECRET_BODY } },
        textEcho('wamid.OK'),
      ]),
      config
    );
    expect(
      logs.some(
        (l) => l.includes('echo without recipient') && l.includes('wamid.NOTO')
      )
    ).toBe(true);
    expect(db.rows('messages').some((m) => m.message_id === 'wamid.OK')).toBe(
      true
    );
  });
});

// ------------------------------------------------------------------

describe('captura', () => {
  const historyValue = (history: unknown[]) => ({
    metadata: { display_phone_number: BUSINESS, phone_number_id: 'pn-a' },
    history,
  });
  const chunk = (phase: number, order: number, threads = 2) => ({
    metadata: { phase, chunk_order: order, progress: 50 },
    threads: Array.from({ length: threads }, (_, i) => ({
      id: `1809555000${i}`,
      messages: [
        {
          from: `1809555000${i}`,
          id: `h-${order}-${i}`,
          timestamp: '1760000000',
          type: 'text',
          text: { body: SECRET_BODY },
        },
      ],
    })),
  });

  it('two history elements → two pending batches, nothing inserted yet', async () => {
    const db = seed();
    const { batchIds } = await handleCoexistenceChange(
      asDb(db),
      'history',
      historyValue([chunk(0, 1, 2), chunk(0, 2, 3)]),
      config
    );
    expect(batchIds).toHaveLength(2);
    const batches = db.rows('whatsapp_coexistence_batches');
    expect(batches.map((b) => b.id)).toEqual(batchIds);
    expect(batches[0]).toMatchObject({
      account_id: A,
      whatsapp_config_id: 'cfg-a',
      field: 'history',
      phase: 0,
      chunk_order: 1,
      progress: 50,
      item_count: 2,
      cursor: 0,
      status: 'pending',
    });
    expect(batches[1].item_count).toBe(3);
    expect(db.rows('messages')).toHaveLength(1);
    expectLogsClean(SECRET_BODY);
  });

  it('the same chunk again → no new batch, logged as already queued', async () => {
    const db = seed();
    await handleCoexistenceChange(
      asDb(db),
      'history',
      historyValue([chunk(1, 7)]),
      config
    );
    const again = await handleCoexistenceChange(
      asDb(db),
      'history',
      historyValue([chunk(1, 7)]),
      config
    );
    expect(again.batchIds).toEqual([]);
    expect(db.rows('whatsapp_coexistence_batches')).toHaveLength(1);
    expect(logs.some((l) => l.includes('history chunk already queued'))).toBe(
      true
    );
  });

  it('2593109 → declined log, no batch; the other element of the same change is queued', async () => {
    const db = seed();
    const { batchIds } = await handleCoexistenceChange(
      asDb(db),
      'history',
      historyValue([
        { errors: [{ code: 2593109, title: 'declined' }] },
        chunk(0, 1),
      ]),
      config
    );
    expect(batchIds).toHaveLength(1);
    expect(db.rows('whatsapp_coexistence_batches')).toHaveLength(1);
    const line = logs.find((l) => l.includes('history sharing declined'));
    expect(line).toContain('"phoneNumberId":"pn-a"');
    expect(line).toContain('2593109');
  });

  it('another error code → history error log, no throw', async () => {
    const db = seed();
    const out = await handleCoexistenceChange(
      asDb(db),
      'history',
      historyValue([{ errors: [{ code: 131000 }] }]),
      config
    );
    expect(out).toEqual({ batchIds: [] });
    expect(
      logs.some((l) => l.includes('history error') && l.includes('131000'))
    ).toBe(true);
  });

  it('smb_app_state_sync → one batch with every contact', async () => {
    const db = seed();
    const { batchIds } = await handleCoexistenceChange(
      asDb(db),
      'smb_app_state_sync',
      {
        metadata: { phone_number_id: 'pn-a' },
        state_sync: [
          {
            type: 'contact',
            action: 'add',
            contact: { full_name: SECRET_NAME, phone_number: CUSTOMER },
          },
          {
            type: 'contact',
            action: 'remove',
            contact: { phone_number: CUSTOMER },
          },
        ],
      },
      config
    );
    expect(batchIds).toHaveLength(1);
    expect(db.rows('whatsapp_coexistence_batches')[0]).toMatchObject({
      field: 'smb_app_state_sync',
      item_count: 2,
      cursor: 0,
      status: 'pending',
      account_id: A,
    });
    expect(db.rows('contacts')).toHaveLength(1);
    expectLogsClean(SECRET_NAME, CUSTOMER);
  });
});

// ------------------------------------------------------------------

describe('account_update', () => {
  const sign = (body: string, secret: string) =>
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const smbFilled = {
    coexistence_onboarded_at: '2026-11-01T00:00:00Z',
    smb_state_sync_requested_at: '2026-11-01T00:00:00Z',
    smb_state_sync_request_id: 'req-s',
    smb_history_sync_requested_at: '2026-11-01T00:00:00Z',
    smb_history_sync_request_id: 'req-h',
    smb_sync_error: 'x',
  };
  const R44 = Object.keys(smbFilled);

  function accountDb() {
    return new FakeDatabase({
      whatsapp_config: [
        {
          id: 'cfg-plat',
          account_id: A,
          waba_id: 'waba-1',
          app_secret: null,
          status: 'connected',
          ...smbFilled,
        },
        {
          id: 'cfg-own',
          account_id: 'acct-b',
          waba_id: 'waba-1',
          app_secret: encrypt('secret-b'),
          status: 'connected',
          ...smbFilled,
        },
        {
          id: 'cfg-own2',
          account_id: 'acct-c',
          waba_id: 'waba-1',
          app_secret: encrypt('secret-c'),
          status: 'connected',
          ...smbFilled,
        },
        {
          id: 'cfg-other',
          account_id: A,
          waba_id: 'waba-2',
          app_secret: null,
          status: 'connected',
          ...smbFilled,
        },
      ],
    });
  }
  const removed = (extra: Record<string, unknown> = {}) => ({
    event: 'PARTNER_REMOVED',
    waba_id: 'waba-1',
    owner_business_id: 'biz',
    reason: 'PRIMARY_INACTIVITY',
    initiated_by: 'SYSTEM',
    ...extra,
  });
  const row = (db: FakeDatabase, id: string) =>
    db.rows('whatsapp_config').find((r) => r.id === id)!;

  it('platform-signed PARTNER_REMOVED disconnects the rows of that WABA without app secret and resets the R44 columns', async () => {
    const db = accountDb();
    await handleAccountUpdate(asDb(db), 'waba-1', removed(), {
      signer: 'platform',
      rawBody: '{}',
      signature: null,
    });
    expect(row(db, 'cfg-plat').status).toBe('disconnected');
    for (const c of R44) expect(row(db, 'cfg-plat')[c]).toBeNull();
    for (const id of ['cfg-own', 'cfg-own2', 'cfg-other']) {
      expect(row(db, id).status).toBe('connected');
      expect(row(db, id).smb_state_sync_request_id).toBe('req-s');
      expect(row(db, id).coexistence_onboarded_at).toBe('2026-11-01T00:00:00Z');
    }
    const updates = db.log.filter(
      (l) => l.table === 'whatsapp_config' && l.op === 'update'
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toEqual([
      { column: 'id', op: 'eq', value: 'cfg-plat' },
      { column: 'account_id', op: 'eq', value: A },
      { column: 'waba_id', op: 'eq', value: 'waba-1' },
    ]);
    const line = logs.find((l) => l.includes('[webhook] partner removed:'));
    expect(line).toContain('"wabaId":"waba-1"');
    expect(line).toContain('"signer":"platform"');
    expect(line).toContain('"reason":"PRIMARY_INACTIVITY"');
    expect(line).toContain('"initiatedBy":"SYSTEM"');
    expect(line).toContain('"disconnected":1');
  });

  it('tenant-signed PARTNER_REMOVED touches only the row whose secret signs it', async () => {
    const db = accountDb();
    const body = JSON.stringify({
      entry: [
        {
          id: 'waba-1',
          changes: [{ field: 'account_update', value: removed() }],
        },
      ],
    });
    await handleAccountUpdate(asDb(db), 'waba-1', removed(), {
      signer: 'tenant',
      rawBody: body,
      signature: sign(body, 'secret-b'),
    });
    expect(row(db, 'cfg-own').status).toBe('disconnected');
    for (const c of R44) expect(row(db, 'cfg-own')[c]).toBeNull();
    expect(row(db, 'cfg-own2').status).toBe('connected');
    expect(row(db, 'cfg-plat').status).toBe('connected');
    expect(row(db, 'cfg-own2').smb_history_sync_request_id).toBe('req-h');
    expectLogsClean('secret-b');
  });

  it('value.waba_id different from entry.id → nothing changes, mismatch logged', async () => {
    const db = accountDb();
    await handleAccountUpdate(
      asDb(db),
      'waba-1',
      removed({ waba_id: 'waba-9' }),
      {
        signer: 'platform',
        rawBody: '{}',
        signature: null,
      }
    );
    expect(db.log.filter((l) => l.op === 'update')).toEqual([]);
    expect(
      logs.some((l) => l.includes('waba mismatch') && l.includes('waba-9'))
    ).toBe(true);
  });

  it('another event → only an informative log, no writes', async () => {
    const db = accountDb();
    await handleAccountUpdate(
      asDb(db),
      'waba-1',
      { event: 'WEBHOOK_CONFIG_UPDATED' },
      {
        signer: 'platform',
        rawBody: '{}',
        signature: null,
      }
    );
    expect(db.log).toEqual([]);
    expect(
      logs.some(
        (l) =>
          l.includes('[webhook] account_update:') &&
          l.includes('WEBHOOK_CONFIG_UPDATED')
      )
    ).toBe(true);
  });
});

describe('describeDbError (review finding 3, R31)', () => {
  it('keeps code and message and drops details/hint, which quote the phone', () => {
    const out = describeDbError({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: `Key (account_id, phone)=(${A}, ${CUSTOMER}) already exists.`,
      hint: CUSTOMER,
    });
    expect(out).toEqual({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    });
    expect(JSON.stringify(out)).not.toContain(CUSTOMER);
    expect(describeDbError('boom')).toEqual({ code: null, message: 'boom' });
  });
});
