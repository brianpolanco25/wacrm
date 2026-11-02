import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FakeDatabase,
  type FakeClient,
  type Row,
} from '@/lib/security/fake-supabase';

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(),
}));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('@/lib/whatsapp/message-charges', () => ({
  recordMessageCharge: vi.fn(),
  parseStatusPricing: vi.fn(),
}));

import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { recordMessageCharge } from '@/lib/whatsapp/message-charges';

import {
  BATCH_MAX_ATTEMPTS,
  claimBatch,
  drainCoexistenceBatches,
  processBatch,
  type BatchRow,
} from './coexistence-batches';

const A = 'acct-a';
const BUSINESS = '18295479000';
const SECRET_BODY = 'texto privado 4471';
const SECRET_NAME = 'Nombre Secreto 8812';

const phoneOf = (i: number) => `1809555${String(1000 + i)}`;

function thread(i: number, msgs = 2) {
  return {
    id: phoneOf(i),
    messages: Array.from({ length: msgs }, (_, k) =>
      k % 2 === 0
        ? {
            from: phoneOf(i),
            id: `wamid.t${i}.m${k}`,
            timestamp: String(1760000000 + i * 100 + k),
            type: 'text',
            text: { body: SECRET_BODY },
            history_context: { status: 'READ' },
          }
        : {
            from: BUSINESS,
            to: phoneOf(i),
            id: `wamid.t${i}.m${k}`,
            timestamp: String(1760000000 + i * 100 + k),
            type: 'image',
            image: { caption: SECRET_BODY },
            history_context: { status: 'DELIVERED' },
          }
    ),
  };
}

function batch(over: Partial<Row> = {}): Row {
  return {
    id: 'batch-1',
    account_id: A,
    whatsapp_config_id: 'cfg-a',
    field: 'history',
    phase: 0,
    chunk_order: 1,
    progress: 10,
    payload: {
      display_phone_number: BUSINESS,
      threads: [thread(1), thread(2), thread(3)],
    },
    item_count: 3,
    cursor: 0,
    status: 'pending',
    attempts: 0,
    last_error: null,
    locked_until: null,
    created_at: '2026-11-02T00:00:00.000Z',
    ...over,
  };
}

function seed(
  batches: Row[] = [batch()],
  extra: Partial<Record<string, Row[]>> = {}
) {
  return new FakeDatabase({
    whatsapp_config: [
      {
        id: 'cfg-a',
        account_id: A,
        user_id: 'user-a',
        phone_number_id: 'pn-a',
        display_phone_number: BUSINESS,
      },
    ],
    contacts: [],
    conversations: [],
    messages: [],
    whatsapp_coexistence_batches: batches,
    ...extra,
  });
}

const asDb = (c: FakeClient | object) => c as unknown as SupabaseClient;
const row = (db: FakeDatabase, id = 'batch-1') =>
  db.rows('whatsapp_coexistence_batches').find((b) => b.id === id)!;

/** A client that behaves like `db.admin` but lets a test intercept `from()`. */
function intercept(
  db: FakeDatabase,
  hook: (table: string, next: () => ReturnType<FakeClient['from']>) => unknown
) {
  return asDb({
    from: (table: string) => hook(table, () => db.admin.from(table)),
    rpc: (n: string, a?: Record<string, unknown>) => db.admin.rpc(n, a),
  });
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

function expectNoForbiddenSideEffects(db: FakeDatabase) {
  expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  expect(dispatchInboundToFlows).not.toHaveBeenCalled();
  expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
  expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  expect(recordMessageCharge).not.toHaveBeenCalled();
  expect(db.log.filter((l) => l.op === 'rpc')).toEqual([]);
}

const FAR = () => Date.now() + 60_000;

describe('history batches', () => {
  it('3 threads → customer/agent messages with original dates; batch done with payload NULL', async () => {
    const db = seed();
    const out = await drainCoexistenceBatches(asDb(db.admin), {
      deadline: FAR(),
      batchIds: ['batch-1'],
    });
    expect(out).toEqual({ processed: 1, completed: 1, pending: 0, failed: 0 });
    expect(db.rows('contacts')).toHaveLength(3);
    expect(db.rows('conversations')).toHaveLength(3);
    const msgs = db.rows('messages');
    expect(msgs).toHaveLength(6);
    expect(msgs.find((m) => m.message_id === 'wamid.t1.m0')).toMatchObject({
      sender_type: 'customer',
      status: 'read',
      created_at: new Date(1760000100 * 1000).toISOString(),
      content_text: SECRET_BODY,
    });
    expect(msgs.find((m) => m.message_id === 'wamid.t1.m1')).toMatchObject({
      sender_type: 'agent',
      status: 'delivered',
      content_text: `[image] ${SECRET_BODY}`,
    });
    const b = row(db);
    expect(b.status).toBe('done');
    expect(b.payload).toBeNull();
    expect(b.cursor).toBe(3);
    expect(typeof b.processed_at).toBe('string');
    const line = logs.find((l) => l.includes('[webhook] history chunk:'));
    expect(line).toContain('"phoneNumberId":"pn-a"');
    expect(line).toContain('"threadsDone":3');
    expect(line).toContain('"threadsTotal":3');
    expect(line).toContain('"messages":6');
    expect(line).toContain('"inserted":6');
    expect(logs.join('\n')).not.toContain(SECRET_BODY);
    expect(logs.join('\n')).not.toContain(phoneOf(1));
    expectNoForbiddenSideEffects(db);
  });

  it('deadline after the first thread → pending at cursor 1; the next drain finishes without repeating or skipping', async () => {
    const db = seed();
    let clock = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const client = intercept(db, (table, next) => {
      const q = next();
      if (table === 'messages') clock = 10_000;
      return q;
    });
    const first = await drainCoexistenceBatches(client, {
      deadline: 5_000,
      batchIds: ['batch-1'],
    });
    expect(first).toEqual({
      processed: 1,
      completed: 0,
      pending: 1,
      failed: 0,
    });
    expect(row(db).status).toBe('pending');
    expect(row(db).cursor).toBe(1);
    expect(row(db).locked_until).toBeNull();
    expect(db.rows('messages')).toHaveLength(2);

    const second = await drainCoexistenceBatches(asDb(db.admin), {
      deadline: 1e15,
      batchIds: ['batch-1'],
    });
    expect(second.completed).toBe(1);
    expect(db.rows('messages')).toHaveLength(6);
    expect(new Set(db.rows('messages').map((m) => m.message_id)).size).toBe(6);
    expect(row(db).status).toBe('done');
  });

  it('two claims in a row → only the first wins', async () => {
    const db = seed();
    const now = new Date();
    const ref = { id: 'batch-1', account_id: A, attempts: 0 };
    const a = await claimBatch(asDb(db.admin), ref, now);
    const b = await claimBatch(asDb(db.admin), ref, now);
    expect(a?.id).toBe('batch-1');
    expect(b).toBeNull();
    expect(row(db).status).toBe('processing');
    expect(row(db).attempts).toBe(1);
    // Even re-reading the attempt count, a live lock is not claimable.
    expect(
      await claimBatch(asDb(db.admin), { ...ref, attempts: 1 }, now)
    ).toBeNull();
  });

  it('a processing batch whose lock expired is claimable again', async () => {
    const db = seed([
      batch({
        status: 'processing',
        attempts: 1,
        locked_until: '2020-01-01T00:00:00.000Z',
      }),
    ]);
    const claimed = await claimBatch(
      asDb(db.admin),
      { id: 'batch-1', account_id: A, attempts: 1 },
      new Date()
    );
    expect(claimed?.attempts).toBe(2);
  });

  it(`an exception ${BATCH_MAX_ATTEMPTS} times → failed with last_error, no payload in it`, async () => {
    const db = seed();
    const client = intercept(db, (table, next) => {
      if (table === 'whatsapp_config') throw new Error('database unavailable');
      return next();
    });
    for (let i = 1; i < BATCH_MAX_ATTEMPTS; i++) {
      await drainCoexistenceBatches(client, {
        deadline: FAR(),
        batchIds: ['batch-1'],
      });
      expect(row(db).status).toBe('pending');
      expect(row(db).attempts).toBe(i);
    }
    const last = await drainCoexistenceBatches(client, {
      deadline: FAR(),
      batchIds: ['batch-1'],
    });
    expect(last.failed).toBe(1);
    expect(row(db).status).toBe('failed');
    expect(row(db).last_error).toBe('database unavailable');
    expect(String(row(db).last_error)).not.toContain(SECRET_BODY);
    // Not retried any more.
    const after = await drainCoexistenceBatches(asDb(db.admin), {
      deadline: FAR(),
    });
    expect(after.processed).toBe(0);
  });

  it('deleted config → failed (config_missing)', async () => {
    const db = seed();
    db.tables.whatsapp_config = [];
    const out = await drainCoexistenceBatches(asDb(db.admin), {
      deadline: FAR(),
      batchIds: ['batch-1'],
    });
    expect(out.failed).toBe(1);
    expect(row(db)).toMatchObject({
      status: 'failed',
      last_error: 'config_missing',
    });
    expect(db.rows('messages')).toEqual([]);
  });

  it('a thread whose insert fails does not stop the batch', async () => {
    const db = seed();
    let calls = 0;
    const client = intercept(db, (table, next) => {
      if (table === 'messages' && calls++ === 0) {
        const failing = {
          upsert: () => failing,
          select: async () => ({ data: null, error: { message: 'boom' } }),
        };
        return failing;
      }
      return next();
    });
    const out = await drainCoexistenceBatches(client, {
      deadline: FAR(),
      batchIds: ['batch-1'],
    });
    expect(out.completed).toBe(1);
    expect(db.rows('messages')).toHaveLength(4);
    expect(row(db).status).toBe('done');
    expect(logs.find((l) => l.includes('history chunk:'))).toContain(
      '"failedThreads":1'
    );
  });

  it('writes are scoped: batch updates by id + account, config re-read by id + account', async () => {
    const db = seed();
    await drainCoexistenceBatches(asDb(db.admin), {
      deadline: FAR(),
      batchIds: ['batch-1'],
    });
    for (const entry of db.log.filter(
      (l) => l.table === 'whatsapp_coexistence_batches' && l.op === 'update'
    )) {
      expect(entry.filters).toContainEqual({
        column: 'account_id',
        op: 'eq',
        value: A,
      });
    }
    const cfg = db.log.find((l) => l.table === 'whatsapp_config');
    expect(cfg?.filters).toEqual([
      { column: 'id', op: 'eq', value: 'cfg-a' },
      { column: 'account_id', op: 'eq', value: A },
    ]);
  });
});

describe('address-book batches', () => {
  const contact = (i: number, name: string | null = `N${i}`) => ({
    type: 'contact',
    action: 'add',
    contact: { ...(name ? { full_name: name } : {}), phone_number: phoneOf(i) },
    metadata: { timestamp: '1762100000' },
  });
  const stateBatch = (items: unknown[]) =>
    batch({
      field: 'smb_app_state_sync',
      phase: null,
      chunk_order: null,
      progress: null,
      payload: { state_sync: items },
      item_count: items.length,
    });

  it('450 contacts → cursor saved at 200, 400 and 450', async () => {
    const db = seed([
      stateBatch(Array.from({ length: 450 }, (_, i) => contact(i))),
    ]);
    await drainCoexistenceBatches(asDb(db.admin), {
      deadline: FAR(),
      batchIds: ['batch-1'],
    });
    const cursors = db.log
      .filter(
        (l) =>
          l.table === 'whatsapp_coexistence_batches' &&
          l.op === 'update' &&
          l.payload?.[0]?.cursor !== undefined &&
          l.payload?.[0]?.status === undefined
      )
      .map((l) => l.payload?.[0]?.cursor);
    expect(cursors).toEqual([200, 400, 450]);
    expect(db.rows('contacts')).toHaveLength(450);
    expect(row(db).status).toBe('done');
  });

  it('add creates or renames without duplicating; remove leaves the contact intact', async () => {
    const db = seed(
      [
        stateBatch([
          contact(1, SECRET_NAME),
          contact(2, 'Nuevo nombre'),
          {
            type: 'contact',
            action: 'remove',
            contact: { phone_number: phoneOf(3) },
          },
          { type: 'label', action: 'add' },
          contact(4, null),
          { type: 'contact', action: 'add', contact: { phone_number: '12' } },
        ]),
      ],
      {
        contacts: [
          {
            id: 'c2',
            account_id: A,
            user_id: 'user-a',
            phone: `+${phoneOf(2)}`,
            name: 'Viejo',
          },
          {
            id: 'c3',
            account_id: A,
            user_id: 'user-a',
            phone: phoneOf(3),
            name: 'Se queda',
          },
        ],
      }
    );
    await drainCoexistenceBatches(asDb(db.admin), {
      deadline: FAR(),
      batchIds: ['batch-1'],
    });
    const contacts = db.rows('contacts');
    expect(contacts).toHaveLength(4);
    expect(contacts.find((c) => c.id === 'c2')?.name).toBe('Nuevo nombre');
    expect(contacts.find((c) => c.id === 'c3')?.name).toBe('Se queda');
    expect(contacts.find((c) => c.phone === phoneOf(1))?.name).toBe(
      SECRET_NAME
    );
    expect(contacts.find((c) => c.phone === phoneOf(4))?.name).toBe(phoneOf(4));
    expect(db.rows('conversations')).toEqual([]);
    const line = logs.find((l) => l.includes('[webhook] contacts sync:'));
    expect(line).toContain('"created":2');
    expect(line).toContain('"existing":1');
    expect(line).toContain('"ignored":2');
    expect(line).toContain('"invalid":1');
    expect(logs.join('\n')).not.toContain(SECRET_NAME);
    expect(logs.join('\n')).not.toContain(phoneOf(1));
    expectNoForbiddenSideEffects(db);
  });
});

describe('processBatch', () => {
  it('never throws, even on a malformed payload', async () => {
    const db = seed([batch({ payload: { threads: 'nope' } })]);
    const claimed = (await claimBatch(
      asDb(db.admin),
      { id: 'batch-1', account_id: A, attempts: 0 },
      new Date()
    )) as BatchRow;
    await expect(processBatch(asDb(db.admin), claimed, FAR())).resolves.toBe(
      'done'
    );
  });
});

describe('cron sweep', () => {
  it('drains oldest first, respects the limit and skips batches locked by another drain', async () => {
    const db = seed([
      batch({
        id: 'b-new',
        created_at: '2026-11-02T03:00:00.000Z',
        chunk_order: 3,
      }),
      batch({
        id: 'b-old',
        created_at: '2026-11-02T01:00:00.000Z',
        chunk_order: 1,
      }),
      batch({
        id: 'b-locked',
        created_at: '2026-11-01T00:00:00.000Z',
        chunk_order: 2,
        status: 'processing',
        locked_until: '2999-01-01T00:00:00.000Z',
      }),
      batch({
        id: 'b-done',
        created_at: '2026-10-01T00:00:00.000Z',
        status: 'done',
        chunk_order: 4,
      }),
    ]);
    const out = await drainCoexistenceBatches(asDb(db.admin), {
      deadline: FAR(),
      limit: 1,
    });
    expect(out).toEqual({ processed: 1, completed: 1, pending: 0, failed: 0 });
    expect(row(db, 'b-old').status).toBe('done');
    expect(row(db, 'b-new').status).toBe('pending');
    expect(row(db, 'b-locked').status).toBe('processing');
  });
});
