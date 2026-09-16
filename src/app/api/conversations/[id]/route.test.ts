import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  setStatus: vi.fn(),
  assign: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/conversations/status-events', () => ({
  setConversationStatus: mocks.setStatus,
  assignConversation: mocks.assign,
}));

import { PATCH } from './route';

const ctx = {
  supabase: { name: 'rls-client' },
  accountId: 'account-1',
  userId: 'user-1',
};

const params = { params: Promise.resolve({ id: 'conv-1' }) };

function req(body: unknown) {
  return new Request('http://localhost/api/conversations/conv-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.requireRole.mockReset().mockResolvedValue(ctx);
  mocks.setStatus.mockReset().mockResolvedValue(true);
  mocks.assign.mockReset().mockResolvedValue(true);
});

describe('PATCH /api/conversations/[id]', () => {
  it('exige agent+ y cierra acotando por cuenta', async () => {
    const res = await PATCH(req({ status: 'closed' }), params);

    expect(res.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.setStatus).toHaveBeenCalledWith(
      { db: ctx.supabase, accountId: 'account-1', conversationId: 'conv-1' },
      'closed'
    );
  });

  it('asigna y desasigna', async () => {
    await PATCH(req({ assigned_agent_id: 'agent-9' }), params);
    expect(mocks.assign).toHaveBeenCalledWith(expect.anything(), 'agent-9');

    await PATCH(req({ assigned_agent_id: null }), params);
    expect(mocks.assign).toHaveBeenLastCalledWith(expect.anything(), null);
  });

  it('404 cuando la conversación no es de la cuenta', async () => {
    mocks.setStatus.mockResolvedValue(false);
    const res = await PATCH(req({ status: 'closed' }), params);
    expect(res.status).toBe(404);
  });

  it('400 ante un estado inventado, sin escribir', async () => {
    const res = await PATCH(req({ status: 'archivado' }), params);
    expect(res.status).toBe(400);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('400 si el agente no es texto ni null', async () => {
    const res = await PATCH(req({ assigned_agent_id: 42 }), params);
    expect(res.status).toBe(400);
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it('400 si el cuerpo no trae ningún campo actualizable', async () => {
    const res = await PATCH(req({ foo: 'bar' }), params);
    expect(res.status).toBe(400);
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it('un rol insuficiente no llega a escribir', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await PATCH(req({ status: 'closed' }), params);
    expect(res.status).toBe(403);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
});
