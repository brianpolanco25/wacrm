import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/flows/admin-client', async () => {
  const mod = await import('@/lib/security/fake-supabase');
  const forward = mod.forwardingClient(() => h.db.admin);
  return { supabaseAdmin: () => forward };
});

import { GET } from './route';

const A = 'acct-a';

function batch(id: string, createdAt: string, over: Partial<Row> = {}): Row {
  return {
    id,
    account_id: A,
    whatsapp_config_id: 'cfg-a',
    field: 'smb_app_state_sync',
    payload: {
      state_sync: [
        {
          type: 'contact',
          action: 'add',
          contact: { full_name: 'X', phone_number: `1809555${id.length}000` },
        },
      ],
    },
    item_count: 1,
    cursor: 0,
    status: 'pending',
    attempts: 0,
    locked_until: null,
    created_at: createdAt,
    ...over,
  };
}

function seed(batches: Row[]) {
  return new FakeDatabase({
    whatsapp_config: [
      { id: 'cfg-a', account_id: A, user_id: 'u', phone_number_id: 'pn-a' },
    ],
    contacts: [],
    whatsapp_coexistence_batches: batches,
  });
}

const call = (secret?: string) =>
  GET(
    new Request('http://localhost/api/whatsapp/coexistence/cron', {
      headers: secret === undefined ? {} : { 'x-cron-secret': secret },
    })
  );

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h.db = seed([
    batch('b2', '2026-11-02T02:00:00.000Z'),
    batch('b1', '2026-11-02T01:00:00.000Z'),
    batch('b-locked', '2026-11-01T00:00:00.000Z', {
      status: 'processing',
      locked_until: '2999-01-01T00:00:00.000Z',
    }),
  ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/whatsapp/coexistence/cron', () => {
  it('503 when AUTOMATION_CRON_SECRET is not set', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    const res = await call('anything');
    expect(res.status).toBe(503);
    expect(h.db.log).toEqual([]);
  });

  it('401 without the header or with a wrong one, without touching the database', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'cron-secret');
    expect((await call()).status).toBe(401);
    expect((await call('cron-secreT')).status).toBe(401);
    expect((await call('short')).status).toBe(401);
    expect(h.db.log).toEqual([]);
  });

  it('with the secret, drains pending batches oldest first and reports counts', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'cron-secret');
    const res = await call('cron-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      processed: 2,
      completed: 2,
      pending: 0,
      failed: 0,
    });
    const rows = h.db.rows('whatsapp_coexistence_batches');
    expect(rows.find((b) => b.id === 'b1')?.status).toBe('done');
    expect(rows.find((b) => b.id === 'b2')?.status).toBe('done');
    // Claimed by another drain: left alone.
    expect(rows.find((b) => b.id === 'b-locked')).toMatchObject({
      status: 'processing',
      attempts: 0,
      cursor: 0,
    });
    const claims = h.db.log.filter(
      (l) =>
        l.table === 'whatsapp_coexistence_batches' &&
        l.op === 'update' &&
        l.payload?.[0]?.status === 'processing'
    );
    expect(
      claims.map((c) => c.filters.find((f) => f.column === 'id')?.value)
    ).toEqual(['b1', 'b2']);
  });
});
