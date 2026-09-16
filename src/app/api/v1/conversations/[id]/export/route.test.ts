import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  rateLimitOk: true,
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

import { SYNC_MESSAGE_LIMIT } from '@/lib/exports/conversations';
import { GET } from './route';

const A = 'acct-a';
const B = 'acct-b';

function seed(messagesInA = 2): FakeDatabase {
  const messages: Row[] = [
    {
      id: 'msg-b',
      conversation_id: 'conv-b',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'secreto de B',
      status: 'delivered',
      created_at: '2025-12-31T00:00:00.000Z',
    },
    ...Array.from({ length: messagesInA }, (_, i) => ({
      id: `msg-a-${i}`,
      conversation_id: 'conv-a',
      sender_type: i % 2 === 0 ? 'customer' : 'agent',
      content_type: 'text',
      content_text: i === 0 ? '=1+1, "ojo"' : `linea ${i}`,
      message_id: `wamid.${i}`,
      status: 'delivered',
      created_at: `2026-09-0${i + 1}T00:00:00.000Z`,
    })),
  ];

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
    messages,
  });
}

let db: FakeDatabase;

function req(id: string, query = '') {
  return new Request(
    `https://crm.example.com/api/v1/conversations/${id}/export${query}`,
    { headers: { authorization: 'Bearer wacrm_live_x' } }
  );
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  db = seed();
  h.rateLimitOk = true;
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue({
    authType: 'api_key',
    supabase: db.admin as unknown as SupabaseClient,
    accountId: A,
    keyId: 'key-a',
    scopes: ['conversations:export'],
    createdBy: 'user-a',
  });
});

describe('GET /api/v1/conversations/{id}/export', () => {
  it('exige el scope conversations:export', async () => {
    await GET(req('conv-a'), params('conv-a'));
    expect(h.requireApiKey.mock.calls[0][1]).toBe('conversations:export');
  });

  it('json: descarga con el documento y las cabeceras de v1', async () => {
    const res = await GET(req('conv-a', '?format=json'), params('conv-a'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="conversation-conv-a.json"'
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toBeTruthy();

    const doc = JSON.parse(await res.text());
    expect(doc.conversation_count).toBe(1);
    expect(doc.message_count).toBe(2);
    expect(doc.conversations[0].messages.map((m: Row) => m.id)).toEqual([
      'msg-a-0',
      'msg-a-1',
    ]);
    // Campos estables de la spec.
    expect(Object.keys(doc.conversations[0].messages[0])).toEqual([
      'conversation_id',
      'id',
      'direction',
      'sender_type',
      'content_type',
      'text',
      'media_url',
      'template_name',
      'status',
      'whatsapp_message_id',
      'created_at',
    ]);
  });

  it('sin ?format sale en json', async () => {
    const res = await GET(req('conv-a'), params('conv-a'));
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('csv: cabecera, una fila por mensaje y escape del texto peligroso', async () => {
    const res = await GET(req('conv-a', '?format=csv'), params('conv-a'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv');
    expect(res.headers.get('content-disposition')).toContain(
      'conversation-conv-a.csv'
    );
    const lines = (await res.text()).trimEnd().split('\r\n');
    expect(lines[0]).toContain('conversation_id,id,direction');
    expect(lines).toHaveLength(3);
    // `=1+1, "ojo"` → apóstrofo delante, comillas duplicadas, todo dentro
    // de una sola celda.
    expect(lines[1]).toContain('"\'=1+1, ""ojo"""');
  });

  it('un formato desconocido es bad_request antes de tocar la base', async () => {
    const res = await GET(req('conv-a', '?format=xlsx'), params('conv-a'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.request_id).toBeTruthy();
  });

  it('una conversación de otra cuenta es 404, no 403', async () => {
    const res = await GET(req('conv-b'), params('conv-b'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(JSON.stringify(body)).not.toContain('secreto de B');
  });

  it('una conversación inexistente también es 404', async () => {
    const res = await GET(req('conv-x'), params('conv-x'));
    expect(res.status).toBe(404);
  });

  it('por encima del tope manda al encargo asíncrono, sin leer los mensajes', async () => {
    const big = seed(1);
    // Mismo efecto que 10 001 filas, sin fabricarlas: el recuento es lo
    // único que decide, y va por `head: true`.
    const admin = big.admin;
    const supabase = {
      from: (table: string) => {
        const query = admin.from(table);
        if (table !== 'messages') return query;
        return {
          ...query,
          select: (cols: string, opts?: { count?: string; head?: boolean }) =>
            opts?.head
              ? {
                  eq: async () => ({
                    count: SYNC_MESSAGE_LIMIT + 1,
                    data: null,
                    error: null,
                  }),
                }
              : query.select(cols),
        };
      },
    } as unknown as SupabaseClient;

    h.requireApiKey.mockResolvedValue({
      authType: 'api_key',
      supabase,
      accountId: A,
      keyId: 'key-a',
      scopes: ['conversations:export'],
      createdBy: 'user-a',
    });

    const res = await GET(req('conv-a'), params('conv-a'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain('POST /api/v1/exports');
  });

  it('el cubo propio de exportaciones corta con 429 y Retry-After', async () => {
    h.rateLimitOk = false;
    const res = await GET(req('conv-a'), params('conv-a'));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
  });
});
