import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// n15.5: pausar/reanudar la IA, marcar leída y la validación de miembro.

const mocks = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@/lib/webhooks/emit', () => ({ emitWebhookEvent: mocks.emit }));

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';
import { checkAccountMember } from './members';
import { markConversationRead, setConversationAiPaused } from './status-events';

const A = 'acct-a';
const B = 'acct-b';

let fake: FakeDatabase;
let db: SupabaseClient;

const conv = (id: string): Row =>
  fake.rows('conversations').find((c) => c.id === id) as Row;

beforeEach(() => {
  mocks.emit.mockReset();
  mocks.emit.mockResolvedValue(undefined);
  fake = new FakeDatabase({
    conversations: [
      {
        id: 'conv-b',
        account_id: B,
        contact_id: 'contact-b',
        status: 'open',
        assigned_agent_id: null,
        ai_autoreply_disabled: false,
        unread_count: 4,
      },
      {
        id: 'conv-a',
        account_id: A,
        contact_id: 'contact-a',
        status: 'open',
        assigned_agent_id: 'agent-1',
        ai_autoreply_disabled: true,
        ai_reply_count: 3,
        ai_handoff_summary: 'nota',
        unread_count: 2,
      },
    ],
    profiles: [
      { id: 'p1', account_id: A, user_id: 'agent-1', account_role: 'agent' },
      { id: 'p2', account_id: A, user_id: 'viewer-1', account_role: 'viewer' },
      { id: 'p3', account_id: B, user_id: 'agent-9', account_role: 'agent' },
    ],
  });
  db = fake.admin as unknown as SupabaseClient;
});

describe('setConversationAiPaused', () => {
  it('reanudar suelta al asignado, reinicia el cupo y emite updated + assigned', async () => {
    const ok = await setConversationAiPaused(
      { db, accountId: A, conversationId: 'conv-a' },
      false
    );
    expect(ok).toBe(true);
    expect(conv('conv-a')).toMatchObject({
      ai_autoreply_disabled: false,
      assigned_agent_id: null,
      ai_reply_count: 0,
      ai_handoff_summary: null,
    });
    expect(mocks.emit).toHaveBeenCalledWith(A, 'conversation.updated', {
      conversation_id: 'conv-a',
      contact_id: 'contact-a',
      fields: ['ai_autoreply_disabled'],
    });
    expect(mocks.emit).toHaveBeenCalledWith(A, 'conversation.assigned', {
      conversation_id: 'conv-a',
      contact_id: 'contact-a',
      assigned_agent_id: null,
    });
  });

  it('pausar con assignTo asigna; pausar lo ya pausado no emite updated', async () => {
    await setConversationAiPaused(
      { db, accountId: A, conversationId: 'conv-a' },
      true,
      { assignTo: 'agent-1' }
    );
    expect(conv('conv-a').ai_autoreply_disabled).toBe(true);
    expect(
      mocks.emit.mock.calls.filter((c) => c[1] === 'conversation.updated')
    ).toHaveLength(0);
  });

  it('una conversación de otra cuenta no existe: ni escribe ni emite', async () => {
    const ok = await setConversationAiPaused(
      { db, accountId: A, conversationId: 'conv-b' },
      true
    );
    expect(ok).toBe(false);
    expect(conv('conv-b').ai_autoreply_disabled).toBe(false);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe('markConversationRead', () => {
  it('pone unread_count a 0 y emite updated solo si había sin leer', async () => {
    const scope = { db, accountId: A, conversationId: 'conv-a' };
    expect(await markConversationRead(scope)).toBe(true);
    expect(conv('conv-a').unread_count).toBe(0);
    expect(mocks.emit).toHaveBeenCalledWith(A, 'conversation.updated', {
      conversation_id: 'conv-a',
      contact_id: 'contact-a',
      fields: ['unread_count'],
    });

    mocks.emit.mockClear();
    expect(await markConversationRead(scope)).toBe(true);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('no toca la conversación de otra cuenta', async () => {
    expect(
      await markConversationRead({ db, accountId: A, conversationId: 'conv-b' })
    ).toBe(false);
    expect(conv('conv-b').unread_count).toBe(4);
  });
});

describe('checkAccountMember', () => {
  it('acepta miembros, rechaza ajenos y, si se pide, viewers', async () => {
    expect(await checkAccountMember(db, A, 'agent-1')).toMatchObject({
      ok: true,
    });
    expect(await checkAccountMember(db, A, 'agent-9')).toEqual({
      ok: false,
      reason: 'not_member',
    });
    expect(await checkAccountMember(db, A, 'viewer-1')).toMatchObject({
      ok: true,
    });
    expect(
      await checkAccountMember(db, A, 'viewer-1', { rejectViewer: true })
    ).toEqual({ ok: false, reason: 'viewer' });
  });
});
