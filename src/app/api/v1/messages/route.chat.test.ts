import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/v1/messages con `conversation_id` y `sent_by_member_id` (n15.5):
// exclusión con `to`, conversación de otra cuenta, miembro inválido.

const h = vi.hoisted(() => ({
  accountId: 'acct-a',
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
  sends: [] as Record<string, unknown>[],
  resolves: 0,
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    authType: 'api_key' as const,
    supabase: h.db.admin,
    accountId: h.accountId,
    keyId: 'key-1',
    scopes: ['messages:send'],
    createdBy: null,
  }),
}));

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationForTarget: async () => {
    h.resolves += 1;
    return { conversationId: 'conv-x', contactId: 'c-x', contactCreated: true };
  },
}));

vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: async (
    _db: unknown,
    _accountId: string,
    params: Record<string, unknown>
  ) => {
    h.sends.push(params);
    return { messageId: 'm-1', whatsappMessageId: 'wamid.1' };
  },
}));

import { FakeDatabase } from '@/lib/security/fake-supabase';
import { POST } from './route';

const post = async (body: unknown) => {
  const res = await POST(
    new Request('https://crm.test/api/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  return { res, body: await res.json() };
};

beforeEach(() => {
  h.accountId = 'acct-a';
  h.sends = [];
  h.resolves = 0;
  h.db = new FakeDatabase({
    conversations: [
      { id: 'conv-a', account_id: 'acct-a', contact_id: 'contact-a' },
      { id: 'conv-b', account_id: 'acct-b', contact_id: 'contact-b' },
    ],
    profiles: [
      {
        id: 'p1',
        account_id: 'acct-a',
        user_id: 'agent-a',
        account_role: 'agent',
      },
      {
        id: 'p2',
        account_id: 'acct-a',
        user_id: 'viewer-a',
        account_role: 'viewer',
      },
      {
        id: 'p3',
        account_id: 'acct-b',
        user_id: 'agent-b',
        account_role: 'agent',
      },
    ],
  });
});

describe('POST /api/v1/messages — conversation_id', () => {
  it('envía por la conversación indicada con el miembro remitente, sin resolver destinatario', async () => {
    const { res, body } = await post({
      conversation_id: 'conv-a',
      sent_by_member_id: 'agent-a',
      type: 'text',
      text: 'hola',
    });
    expect(res.status).toBe(201);
    expect(h.resolves).toBe(0);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      conversationId: 'conv-a',
      senderId: 'agent-a',
    });
    expect(body.data).toMatchObject({
      conversation_id: 'conv-a',
      contact_id: 'contact-a',
      contact_created: false,
    });
  });

  it('sin sent_by_member_id envía sin remitente', async () => {
    await post({ conversation_id: 'conv-a', type: 'text', text: 'hola' });
    expect(h.sends[0]).toMatchObject({ senderId: null });
  });

  it('una conversación de otra cuenta es 404 y no envía', async () => {
    const { res } = await post({
      conversation_id: 'conv-b',
      type: 'text',
      text: 'hola',
    });
    expect(res.status).toBe(404);
    expect(h.sends).toHaveLength(0);
  });

  it('no se puede combinar con to ni to_user_id', async () => {
    for (const extra of [{ to: '+14155550123' }, { to_user_id: 'US.123' }]) {
      const { res } = await post({
        conversation_id: 'conv-a',
        type: 'text',
        text: 'hola',
        ...extra,
      });
      expect(res.status).toBe(400);
    }
    expect(h.sends).toHaveLength(0);
  });

  it('un remitente ajeno, viewer o inexistente es 400 invalid_member y no envía', async () => {
    for (const member of ['agent-b', 'viewer-a', 'nadie']) {
      const { res, body } = await post({
        conversation_id: 'conv-a',
        sent_by_member_id: member,
        type: 'text',
        text: 'hola',
      });
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('invalid_member');
    }
    expect(h.sends).toHaveLength(0);
  });

  it('el envío por `to` sigue resolviendo la conversación como antes', async () => {
    const { res } = await post({
      to: '+14155550123',
      type: 'text',
      text: 'hi',
    });
    expect(res.status).toBe(201);
    expect(h.resolves).toBe(1);
    expect(h.sends[0]).toMatchObject({ conversationId: 'conv-x' });
  });
});
