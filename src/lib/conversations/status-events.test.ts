import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('@/lib/webhooks/emit', () => ({ emitWebhookEvent: mocks.emit }));

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';
import {
  applyConversationChangeByContact,
  assignConversation,
  setConversationStatus,
} from './status-events';

const A = 'acct-a';
const B = 'acct-b';

let fake: FakeDatabase;
let db: SupabaseClient;

function conversations(): Row[] {
  return fake.rows('conversations');
}

beforeEach(() => {
  mocks.emit.mockReset();
  mocks.emit.mockResolvedValue(undefined);
  fake = new FakeDatabase({
    conversations: [
      // B primero: una consulta sin `account_id` caería aquí.
      {
        id: 'conv-b',
        account_id: B,
        contact_id: 'contact-b',
        status: 'open',
        assigned_agent_id: null,
      },
      {
        id: 'conv-a',
        account_id: A,
        contact_id: 'contact-a',
        status: 'open',
        assigned_agent_id: null,
      },
      {
        id: 'conv-a2',
        account_id: A,
        contact_id: 'contact-a',
        status: 'closed',
        assigned_agent_id: 'agent-1',
      },
    ],
  });
  db = fake.admin as unknown as SupabaseClient;
});

describe('setConversationStatus', () => {
  it('cierra y emite conversation.closed una sola vez', async () => {
    const scope = { db, accountId: A, conversationId: 'conv-a' };

    expect(await setConversationStatus(scope, 'closed')).toBe(true);
    expect(conversations().find((c) => c.id === 'conv-a')?.status).toBe(
      'closed'
    );
    expect(mocks.emit).toHaveBeenCalledWith(A, 'conversation.closed', {
      conversation_id: 'conv-a',
      contact_id: 'contact-a',
    });

    // Cerrar lo ya cerrado no es noticia.
    mocks.emit.mockClear();
    expect(await setConversationStatus(scope, 'closed')).toBe(true);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('reabrir no emite conversation.closed', async () => {
    await setConversationStatus(
      { db, accountId: A, conversationId: 'conv-a2' },
      'open'
    );
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('una conversación de otra cuenta no existe: ni escribe ni emite', async () => {
    const ok = await setConversationStatus(
      { db, accountId: A, conversationId: 'conv-b' },
      'closed'
    );
    expect(ok).toBe(false);
    expect(conversations().find((c) => c.id === 'conv-b')?.status).toBe('open');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe('assignConversation', () => {
  it('asigna y emite conversation.assigned', async () => {
    const ok = await assignConversation(
      { db, accountId: A, conversationId: 'conv-a' },
      'agent-7'
    );
    expect(ok).toBe(true);
    expect(
      conversations().find((c) => c.id === 'conv-a')?.assigned_agent_id
    ).toBe('agent-7');
    expect(mocks.emit).toHaveBeenCalledWith(A, 'conversation.assigned', {
      conversation_id: 'conv-a',
      contact_id: 'contact-a',
      assigned_agent_id: 'agent-7',
    });
  });

  it('no emite si el agente es el mismo', async () => {
    await assignConversation(
      { db, accountId: A, conversationId: 'conv-a2' },
      'agent-1'
    );
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('desasignar (null) sí es un cambio', async () => {
    await assignConversation(
      { db, accountId: A, conversationId: 'conv-a2' },
      null
    );
    expect(mocks.emit).toHaveBeenCalledWith(A, 'conversation.assigned', {
      conversation_id: 'conv-a2',
      contact_id: 'contact-a',
      assigned_agent_id: null,
    });
  });

  it('id de otra cuenta → false, sin tocar la fila', async () => {
    expect(
      await assignConversation(
        { db, accountId: A, conversationId: 'conv-b' },
        'agent-7'
      )
    ).toBe(false);
    expect(
      conversations().find((c) => c.id === 'conv-b')?.assigned_agent_id
    ).toBe(null);
  });
});

describe('applyConversationChangeByContact (motor de automatizaciones)', () => {
  it('cierra las del contacto y emite solo por las que estaban abiertas', async () => {
    await applyConversationChangeByContact(db, A, 'contact-a', {
      status: 'closed',
    });

    expect(
      conversations()
        .filter((c) => c.account_id === A)
        .every((c) => c.status === 'closed')
    ).toBe(true);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith(A, 'conversation.closed', {
      conversation_id: 'conv-a',
      contact_id: 'contact-a',
    });
  });

  it('no toca las conversaciones de otra cuenta con el mismo contacto', async () => {
    await applyConversationChangeByContact(db, A, 'contact-b', {
      status: 'closed',
    });
    expect(conversations().find((c) => c.id === 'conv-b')?.status).toBe('open');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('asigna y emite una vez por conversación que cambió', async () => {
    await applyConversationChangeByContact(db, A, 'contact-a', {
      assignedAgentId: 'agent-1',
    });
    // conv-a2 ya era de agent-1; solo conv-a cambió.
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith(A, 'conversation.assigned', {
      conversation_id: 'conv-a',
      contact_id: 'contact-a',
      assigned_agent_id: 'agent-1',
    });
  });
});
