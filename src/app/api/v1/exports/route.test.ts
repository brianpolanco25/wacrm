import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  rateLimitOk: true,
  after: [] as (() => Promise<void> | void)[],
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (cb: () => Promise<void> | void) => {
    h.after.push(cb);
  },
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) =>
    (h.requireApiKey as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({
    success: h.rateLimitOk,
    limit: 10,
    remaining: h.rateLimitOk ? 9 : 0,
    reset: Date.now() + 3_600_000,
  }),
}));

import { FakeIdempotencyStore } from '@/lib/api/v1/fake-idempotency-store';
import { __resetIdempotencyPurgeCounter } from '@/lib/api/v1/idempotency';
import { EXPORTS_BUCKET } from '@/lib/exports/jobs';
import { GET, POST } from './route';

const A = 'acct-a';
const B = 'acct-b';

function seed(jobs: Row[] = []): FakeDatabase {
  return new FakeDatabase({
    conversations: [
      {
        id: 'conv-b',
        account_id: B,
        contact_id: 'contact-b',
        status: 'open',
        unread_count: 0,
        created_at: '2025-12-31T00:00:00.000Z',
        updated_at: '2025-12-31T00:00:00.000Z',
      },
      {
        id: 'conv-a',
        account_id: A,
        contact_id: 'contact-a',
        status: 'open',
        unread_count: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    contacts: [
      { id: 'contact-b', account_id: B, phone: '+34600000002', name: 'B' },
      { id: 'contact-a', account_id: A, phone: '+34600000001', name: 'A' },
    ],
    messages: [
      {
        id: 'msg-b',
        conversation_id: 'conv-b',
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'secreto de B',
        status: 'delivered',
        created_at: '2025-12-31T00:00:00.000Z',
      },
      {
        id: 'msg-a',
        conversation_id: 'conv-a',
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'hola desde A',
        status: 'delivered',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    export_jobs: jobs,
  });
}

let db: FakeDatabase;
let idempotency: FakeIdempotencyStore;

/**
 * Rol de servicio de la ruta: las tablas normales las sirve
 * `FakeDatabase`, y `api_idempotency_keys` el doble que sí arbitra el
 * índice UNIQUE (es lo único que hace que la idempotencia signifique
 * algo en un test).
 */
function serviceClient(): SupabaseClient {
  return {
    from: (table: string) =>
      table === 'api_idempotency_keys'
        ? idempotency.from(table)
        : db.admin.from(table),
    storage: { from: (bucket: string) => db.admin.storage.from(bucket) },
  } as unknown as SupabaseClient;
}

function job(over: Partial<Row> & { id: string }): Row {
  return {
    account_id: A,
    api_key_id: 'key-a',
    kind: 'conversations',
    params: {},
    format: 'json',
    status: 'done',
    row_count: 1,
    file_path: `${A}/${over.id}.json`,
    error: null,
    created_at: '2026-09-16T11:00:00.000Z',
    started_at: null,
    finished_at: '2026-09-16T11:00:05.000Z',
    expires_at: '2026-09-23T11:00:00.000Z',
    ...over,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://crm.example.com/api/v1/exports', {
    method: 'POST',
    headers: {
      authorization: 'Bearer wacrm_live_x',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function list(query = '') {
  return new Request(`https://crm.example.com/api/v1/exports${query}`, {
    headers: { authorization: 'Bearer wacrm_live_x' },
  });
}

beforeEach(() => {
  db = seed();
  idempotency = new FakeIdempotencyStore();
  __resetIdempotencyPurgeCounter();
  h.after = [];
  h.rateLimitOk = true;
  h.requireApiKey.mockReset();
  h.requireApiKey.mockImplementation(async () => ({
    authType: 'api_key',
    supabase: serviceClient(),
    accountId: A,
    keyId: 'key-a',
    scopes: ['conversations:export'],
    createdBy: 'user-a',
  }));
});

describe('POST /api/v1/exports', () => {
  it('202 con el encargo en queued y el scope correcto', async () => {
    const res = await POST(post({ kind: 'conversations', format: 'csv' }));
    expect(res.status).toBe(202);
    expect(h.requireApiKey.mock.calls[0][1]).toBe('conversations:export');

    const body = await res.json();
    expect(body.data.status).toBe('queued');
    expect(body.data.format).toBe('csv');
    expect(body.data).not.toHaveProperty('file_path');
    expect(body.data).not.toHaveProperty('account_id');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const row = db.rows('export_jobs')[0];
    expect(row.account_id).toBe(A);
    expect(row.api_key_id).toBe('key-a');
  });

  it('el cuerpo vacío encarga el export por defecto (conversations/json)', async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.kind).toBe('conversations');
    expect(body.data.format).toBe('json');
  });

  it('after() construye el archivo y deja el encargo en done', async () => {
    const res = await POST(post({ format: 'json' }));
    const body = await res.json();
    expect(h.after).toHaveLength(1);

    await h.after[0]?.();

    const row = db.rows('export_jobs')[0];
    expect(row.id).toBe(body.data.id);
    expect(row.status).toBe('done');
    expect(db.storageObjects).toEqual([
      { bucket: EXPORTS_BUCKET, path: `${A}/${row.id}.json` },
    ]);
  });

  it('los filtros se guardan validados y sin account_id', async () => {
    await POST(
      post({
        filters: {
          status: 'closed',
          from: '2026-01-01',
          account_id: B,
          nope: true,
        },
      })
    );
    expect(db.rows('export_jobs')[0].params).toEqual({
      status: 'closed',
      from: '2026-01-01T00:00:00.000Z',
    });
  });

  it('un filtro mal tipado es 400 y nombra el campo, sin encolar nada', async () => {
    const res = await POST(post({ filters: { from: 'ayer' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('filters.from');
    expect(db.rows('export_jobs')).toHaveLength(0);
  });

  it('un kind o un formato desconocido es 400', async () => {
    expect((await POST(post({ kind: 'contacts' }))).status).toBe(400);
    expect((await POST(post({ format: 'xlsx' }))).status).toBe(400);
    expect(db.rows('export_jobs')).toHaveLength(0);
  });

  it('sin Content-Type json es 415 (readJsonBody, nunca request.json())', async () => {
    const res = await POST(
      new Request('https://crm.example.com/api/v1/exports', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wacrm_live_x',
          'content-type': 'text/plain',
        },
        body: '{}',
      })
    );
    expect(res.status).toBe(415);
  });

  it('la misma Idempotency-Key no encarga dos exports', async () => {
    const first = await POST(
      post({ format: 'csv' }, { 'Idempotency-Key': 'k1' })
    );
    const second = await POST(
      post({ format: 'csv' }, { 'Idempotency-Key': 'k1' })
    );
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(db.rows('export_jobs')).toHaveLength(1);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.data.id).toBe(firstBody.data.id);
  });

  it('el cubo propio corta con 429 antes de encolar', async () => {
    h.rateLimitOk = false;
    const res = await POST(post({}));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(db.rows('export_jobs')).toHaveLength(0);
  });
});

describe('GET /api/v1/exports', () => {
  it('lista solo los encargos de la cuenta, el último primero', async () => {
    db = seed([
      job({
        id: 'job-b',
        account_id: B,
        created_at: '2026-09-16T11:30:00.000Z',
      }),
      job({ id: 'job-a1', created_at: '2026-09-16T10:00:00.000Z' }),
      job({ id: 'job-a2', created_at: '2026-09-16T11:00:00.000Z' }),
    ]);
    const res = await GET(list());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: Row) => r.id)).toEqual(['job-a2', 'job-a1']);
    expect(JSON.stringify(body)).not.toContain('job-b');
    expect(body.meta.next_cursor).toBeNull();
  });

  it('no publica la ruta del archivo en el bucket', async () => {
    db = seed([job({ id: 'job-a1' })]);
    const body = await (await GET(list())).json();
    expect(body.data[0]).not.toHaveProperty('file_path');
    expect(JSON.stringify(body)).not.toContain(`${A}/job-a1.json`);
  });

  it('pagina con cursor', async () => {
    // Ids en forma de UUID: el cursor de `pagination.ts` descarta
    // cualquier otra cosa como no acuñado por el servidor.
    const older = '11111111-1111-4111-8111-111111111111';
    const newer = '22222222-2222-4222-8222-222222222222';
    db = seed([
      job({ id: older, created_at: '2026-09-16T10:00:00.000Z' }),
      job({ id: newer, created_at: '2026-09-16T11:00:00.000Z' }),
    ]);
    const first = await (await GET(list('?limit=1'))).json();
    expect(first.data.map((r: Row) => r.id)).toEqual([newer]);
    expect(first.meta.next_cursor).toBeTruthy();

    const second = await (
      await GET(list(`?limit=1&cursor=${first.meta.next_cursor}`))
    ).json();
    expect(second.data.map((r: Row) => r.id)).toEqual([older]);
  });
});
