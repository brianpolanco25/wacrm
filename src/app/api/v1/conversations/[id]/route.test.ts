import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH/GET /api/v1/conversations/{id} (n15.5): scope, cuenta ajena,
// miembro inválido, validación previa a escribir y eventos.

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  emit: vi.fn(),
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: h.requireApiKey }));
vi.mock('@/lib/webhooks/emit', () => ({ emitWebhookEvent: h.emit }));

import { FakeDatabase } from '@/lib/security/fake-supabase';
import { forbidden } from '@/lib/api/v1/respond';
import { GET, PATCH } from './route';

const A = 'acct-a';
const B = 'acct-b';
const CONV_A = '00000000-0000-4000-8000-00000000000a';
const CONV_B = '00000000-0000-4000-8000-00000000000b';

function seed(): FakeDatabase {
  const base = {
    status: 'open',
    assigned_agent_id: null,
    ai_autoreply_disabled: true,
    ai_reply_count: 2,
    ai_handoff_summary: 'x',
    unread_count: 5,
    last_message_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  return new FakeDatabase({
    conversations: [
      { id: CONV_A, account_id: A, contact_id: 'c-a', ...base },
      { id: CONV_B, account_id: B, contact_id: 'c-b', ...base },
    ],
    contacts: [
      { id: 'c-a', account_id: A, name: 'Ana', phone: '+1' },
      { id: 'c-b', account_id: B, name: 'Zoe', phone: '+2' },
    ],
    profiles: [
      { id: 'p1', account_id: A, user_id: 'agent-a', account_role: 'agent' },
      { id: 'p2', account_id: A, user_id: 'viewer-a', account_role: 'viewer' },
      { id: 'p3', account_id: B, user_id: 'agent-b', account_role: 'agent' },
    ],
    ai_configs: [],
  });
}

function key(accountId: string) {
  return {
    authType: 'api_key',
    supabase: h.db.admin,
    accountId,
    keyId: `key-${accountId}`,
    scopes: ['conversations:write'],
    createdBy: null,
  };
}

const patch = async (id: string, body: unknown) => {
  const res = await PATCH(
    new Request(`https://crm.test/api/v1/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
  return { res, body: await res.json() };
};
const row = (id: string) =>
  h.db.rows('conversations').find((c) => c.id === id)!;

beforeEach(() => {
  h.db = seed();
  h.emit.mockReset();
  h.emit.mockResolvedValue(undefined);
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue(key(A));
});

describe('PATCH /api/v1/conversations/{id}', () => {
  it('exige el scope conversations:write; sin él responde 403 y no escribe', async () => {
    h.requireApiKey.mockRejectedValue(forbidden('missing scope'));
    const { res } = await patch(CONV_A, { read: true });
    expect(res.status).toBe(403);
    expect(row(CONV_A).unread_count).toBe(5);
    expect(h.requireApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'conversations:write'
    );
  });

  it('una conversación de otra cuenta es 404 y no se toca', async () => {
    const { res } = await patch(CONV_B, { status: 'closed', read: true });
    expect(res.status).toBe(404);
    expect(row(CONV_B)).toMatchObject({ status: 'open', unread_count: 5 });
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('asigna, cierra y marca leída; devuelve la conversación y emite los eventos', async () => {
    const { res, body } = await patch(CONV_A, {
      assigned_agent_id: 'agent-a',
      status: 'closed',
      read: true,
    });
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      id: CONV_A,
      assigned_agent_id: 'agent-a',
      status: 'closed',
      unread_count: 0,
    });
    const events = h.emit.mock.calls.map((c) => [c[0], c[1]]);
    expect(events).toEqual(
      expect.arrayContaining([
        [A, 'conversation.assigned'],
        [A, 'conversation.closed'],
        [A, 'conversation.updated'],
      ])
    );
    expect(h.emit.mock.calls.every((c) => c[0] === A)).toBe(true);
  });

  it('reanudar la IA suelta al asignado y reinicia el cupo; pausar la deja pausada', async () => {
    const resumed = await patch(CONV_A, { ai_autoreply_disabled: false });
    expect(resumed.body.data.ai.paused).toBe(false);
    expect(row(CONV_A)).toMatchObject({
      ai_reply_count: 0,
      ai_handoff_summary: null,
      assigned_agent_id: null,
    });
    const paused = await patch(CONV_A, { ai_autoreply_disabled: true });
    expect(paused.body.data.ai.paused).toBe(true);
  });

  it('un miembro ajeno o viewer es 400 invalid_member y no cambia nada', async () => {
    for (const agent of ['agent-b', 'viewer-a', 'nadie']) {
      const { res, body } = await patch(CONV_A, {
        assigned_agent_id: agent,
        status: 'closed',
      });
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('invalid_member');
    }
    expect(row(CONV_A)).toMatchObject({
      status: 'open',
      assigned_agent_id: null,
    });
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('null desasigna', async () => {
    await patch(CONV_A, { assigned_agent_id: 'agent-a' });
    const { body } = await patch(CONV_A, { assigned_agent_id: null });
    expect(body.data.assigned_agent_id).toBeNull();
  });

  it('valida todo antes de escribir: un campo inválido deja la conversación intacta', async () => {
    for (const bad of [
      {},
      { status: 'archivada' },
      { read: false },
      { ai_autoreply_disabled: 'si' },
      { assigned_agent_id: 7 },
      { read: true, status: 'archivada' },
    ]) {
      const { res } = await patch(CONV_A, bad);
      expect(res.status).toBe(400);
    }
    expect(row(CONV_A)).toMatchObject({ status: 'open', unread_count: 5 });
  });
});

describe('GET /api/v1/conversations/{id}', () => {
  it('lee con ventana e IA y responde 404 con una conversación de otra cuenta', async () => {
    h.requireApiKey.mockResolvedValue({
      ...key(A),
      scopes: ['conversations:read'],
    });
    const ok = await GET(new Request('https://crm.test/x'), {
      params: Promise.resolve({ id: CONV_A }),
    });
    const body = await ok.json();
    expect(ok.status).toBe(200);
    expect(body.data).toHaveProperty('service_window_expires_at', null);
    expect(body.data.ai).toMatchObject({ paused: true });

    const foreign = await GET(new Request('https://crm.test/x'), {
      params: Promise.resolve({ id: CONV_B }),
    });
    expect(foreign.status).toBe(404);
  });
});
