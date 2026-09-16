import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';
import type { Conversation, Message } from '@/types';
import {
  ASYNC_MESSAGE_LIMIT,
  ExportTooLargeError,
  SYNC_MESSAGE_LIMIT,
  buildConversationsDocument,
  buildSingleConversationDocument,
  countConversationMessages,
  exportContentType,
  exportExtension,
  exportMediaReference,
  fetchConversationMessages,
  fetchConversations,
  isExportFormat,
  renderExport,
  serializeExportMessage,
} from './conversations';

const A = 'acct-a';
const B = 'acct-b';

function message(over: Partial<Message> & { id: string }): Message {
  return {
    conversation_id: 'conv-a',
    sender_type: 'customer',
    content_type: 'text',
    content_text: 'hola',
    status: 'delivered',
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  } as Message;
}

/** Dos cuentas; B va primero para que una consulta sin filtro case con ella. */
function seed(): FakeDatabase {
  const rows = (tag: string, acct: string, n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `msg-${tag}-${i}`,
      conversation_id: `conv-${tag}`,
      sender_type: i % 2 === 0 ? 'customer' : 'agent',
      content_type: 'text',
      content_text: `m${i} de ${tag}`,
      message_id: `wamid.${tag}.${i}`,
      status: 'delivered',
      created_at: `2026-09-0${i + 1}T00:00:00.000Z`,
    }));

  return new FakeDatabase({
    conversations: [
      {
        id: 'conv-b',
        account_id: B,
        contact_id: 'contact-b',
        status: 'closed',
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
      {
        id: 'conv-a2',
        account_id: A,
        contact_id: 'contact-a2',
        status: 'closed',
        unread_count: 0,
        created_at: '2026-02-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z',
      },
    ],
    contacts: [
      { id: 'contact-b', account_id: B, phone: '+34600000002', name: 'B' },
      { id: 'contact-a', account_id: A, phone: '+34600000001', name: 'A' },
      { id: 'contact-a2', account_id: A, phone: '+34600000003', name: 'A2' },
    ],
    messages: [...rows('b', B, 2), ...rows('a', A, 3), ...rows('a2', A, 2)],
  });
}

function admin(db: FakeDatabase): SupabaseClient {
  return db.admin as unknown as SupabaseClient;
}

describe('serializeExportMessage', () => {
  it('proyecta las columnas estables de la spec y renombra el id de Meta', () => {
    const row = serializeExportMessage(
      message({
        id: 'msg-1',
        sender_type: 'agent',
        content_text: 'respuesta',
        message_id: 'wamid.out',
        template_name: 'saludo',
      })
    );
    expect(row).toEqual({
      conversation_id: 'conv-a',
      id: 'msg-1',
      direction: 'outbound',
      sender_type: 'agent',
      content_type: 'text',
      text: 'respuesta',
      media_url: null,
      template_name: 'saludo',
      status: 'delivered',
      whatsapp_message_id: 'wamid.out',
      created_at: '2026-09-01T00:00:00.000Z',
    });
  });

  it('`customer` es entrante y el resto saliente', () => {
    expect(serializeExportMessage(message({ id: 'm' })).direction).toBe(
      'inbound'
    );
    expect(
      serializeExportMessage(message({ id: 'm', sender_type: 'bot' })).direction
    ).toBe('outbound');
  });
});

describe('exportMediaReference — adjuntos privados (f2 private-media)', () => {
  it('un objeto de nuestros buckets sale como ruta interna, no como URL', () => {
    expect(
      exportMediaReference(
        'https://proj.supabase.co/storage/v1/object/public/chat-media/acct/foto.jpg'
      )
    ).toBe('storage://chat-media/acct/foto.jpg');
  });

  it('una URL firmada tampoco se copia: se reduce a la misma referencia', () => {
    // Lo que la spec prohíbe es persistir una firma. Si llegara una en
    // la columna, el export guarda el objeto al que apunta, no el token.
    const ref = exportMediaReference(
      'https://proj.supabase.co/storage/v1/object/sign/chat-media/acct/foto.jpg?token=abc'
    );
    expect(ref).toBe('storage://chat-media/acct/foto.jpg');
    expect(ref).not.toContain('token');
  });

  it('un enlace ajeno sale tal cual y la ausencia, como null', () => {
    expect(exportMediaReference('https://lookaside.fbcdn.net/x.jpg')).toBe(
      'https://lookaside.fbcdn.net/x.jpg'
    );
    expect(exportMediaReference(null)).toBeNull();
    expect(exportMediaReference(undefined)).toBeNull();
  });
});

describe('formato', () => {
  it('reconoce json y csv, y nada más', () => {
    expect(isExportFormat('json')).toBe(true);
    expect(isExportFormat('csv')).toBe(true);
    expect(isExportFormat('xlsx')).toBe(false);
    expect(isExportFormat(undefined)).toBe(false);
  });

  it('tipo de contenido y extensión', () => {
    expect(exportContentType('json')).toBe('application/json');
    expect(exportContentType('csv')).toBe('text/csv');
    expect(exportExtension('csv')).toBe('csv');
  });
});

describe('lectura acotada por cuenta', () => {
  it('cuenta los mensajes de una conversación sin traer filas', async () => {
    const db = seed();
    await expect(countConversationMessages(admin(db), 'conv-a')).resolves.toBe(
      3
    );
    const log = db.log.at(-1);
    expect(log?.table).toBe('messages');
    expect(log?.filters.map((f) => f.column)).toContain('conversation_id');
  });

  it('los mensajes salen en orden cronológico y solo los de esa conversación', async () => {
    const db = seed();
    const rows = await fetchConversationMessages(admin(db), 'conv-a');
    expect(rows.map((r) => r.id)).toEqual(['msg-a-0', 'msg-a-1', 'msg-a-2']);
    expect(rows.every((r) => r.conversation_id === 'conv-a')).toBe(true);
  });

  it('pagina: varias vueltas de `range` devuelven el conjunto entero una sola vez', async () => {
    const db = seed();
    const rows = await fetchConversationMessages(admin(db), 'conv-a', {
      pageSize: 2,
    });
    expect(rows.map((r) => r.id)).toEqual(['msg-a-0', 'msg-a-1', 'msg-a-2']);
  });

  it('`max` corta la lectura (es el tope del camino síncrono)', async () => {
    const db = seed();
    const rows = await fetchConversationMessages(admin(db), 'conv-a', {
      max: 2,
      pageSize: 2,
    });
    expect(rows).toHaveLength(2);
  });

  it('las conversaciones se filtran SIEMPRE por account_id', async () => {
    const db = seed();
    const rows = await fetchConversations(admin(db), A);
    expect(rows.map((r) => r.id)).toEqual(['conv-a', 'conv-a2']);
    const log = db.log.at(-1);
    expect(log?.filters.some((f) => f.column === 'account_id')).toBe(true);
  });

  it('los filtros del encargo acotan, nunca amplían', async () => {
    const db = seed();
    const rows = await fetchConversations(admin(db), A, {
      status: 'closed',
      from: '2026-01-15T00:00:00.000Z',
    });
    expect(rows.map((r) => r.id)).toEqual(['conv-a2']);
  });
});

describe('documentos', () => {
  it('el síncrono trae una conversación con sus mensajes', async () => {
    const db = seed();
    const conv = db
      .rows('conversations')
      .find((c) => c.id === 'conv-a') as unknown as Conversation;
    const messages = await fetchConversationMessages(admin(db), 'conv-a');
    const doc = buildSingleConversationDocument(
      conv,
      messages,
      new Date('2026-09-16T10:00:00.000Z')
    );
    expect(doc.generated_at).toBe('2026-09-16T10:00:00.000Z');
    expect(doc.conversation_count).toBe(1);
    expect(doc.message_count).toBe(3);
    expect(doc.conversations[0].conversation.id).toBe('conv-a');
    // El sobre público de la conversación no lleva columnas internas.
    expect(doc.conversations[0].conversation).not.toHaveProperty('account_id');
  });

  it('el asíncrono recorre todas las de la cuenta y ninguna ajena', async () => {
    const db = seed();
    const doc = await buildConversationsDocument(admin(db), A);
    expect(doc.conversations.map((c) => c.conversation.id)).toEqual([
      'conv-a',
      'conv-a2',
    ]);
    expect(doc.message_count).toBe(5);
    const ids = JSON.stringify(doc);
    expect(ids).not.toContain('conv-b');
    expect(ids).not.toContain('msg-b-0');
  });

  it('pasado el techo de memoria lanza en vez de dar un export a medias', async () => {
    const db = seed();
    await expect(
      buildConversationsDocument(admin(db), A, {}, { maxMessages: 4 })
    ).rejects.toBeInstanceOf(ExportTooLargeError);
  });

  it('el mensaje del techo dice cómo partir el export y no expone SQL', async () => {
    const err = new ExportTooLargeError(ASYNC_MESSAGE_LIMIT);
    expect(err.message).toContain('from');
    expect(err.message).toContain('to');
    expect(err.message).not.toMatch(/select|from public\./i);
  });

  it('el tope del camino síncrono es el de la spec', () => {
    expect(SYNC_MESSAGE_LIMIT).toBe(10_000);
  });
});

describe('renderExport', () => {
  it('json conserva la relación conversación → mensajes', async () => {
    const db = seed();
    const doc = await buildConversationsDocument(admin(db), A);
    const parsed = JSON.parse(renderExport(doc, 'json'));
    expect(parsed.conversations).toHaveLength(2);
    expect(parsed.conversations[0].messages).toHaveLength(3);
  });

  it('csv aplana a una fila por mensaje con conversation_id delante', async () => {
    const db = seed();
    const doc = await buildConversationsDocument(admin(db), A);
    const lines = renderExport(doc, 'csv').trimEnd().split('\r\n');
    expect(lines[0].split(',')[0]).toBe('conversation_id');
    expect(lines).toHaveLength(6); // cabecera + 5 mensajes
    expect(lines[1].startsWith('conv-a,msg-a-0,')).toBe(true);
  });

  it('un mensaje con coma, comillas y fórmula sobrevive al CSV', () => {
    const doc = {
      generated_at: '2026-09-16T10:00:00.000Z',
      conversation_count: 1,
      message_count: 1,
      conversations: [
        {
          conversation: { id: 'conv-a' } as never,
          messages: [
            serializeExportMessage(
              message({
                id: 'msg-x',
                content_text: '=HYPERLINK("http://malo"),"ya"',
              })
            ),
          ],
        },
      ],
    };
    const csv = renderExport(doc, 'csv');
    const cells = csv.split('\r\n')[1];
    expect(cells).toContain('"\'=HYPERLINK(""http://malo""),""ya"""');
  });
});
