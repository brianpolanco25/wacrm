import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  setStatus: vi.fn(),
  assign: vi.fn(),
  // `profiles` rows the member lookup can see: [user_id, account_id].
  profiles: [] as { user_id: string; account_id: string }[],
  profileQueries: [] as { column: string; value: unknown }[][],
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

/** RLS client double: only `profiles` is queried by the route itself. */
const supabase = {
  from(table: string) {
    if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
    const filters: { column: string; value: unknown }[] = [];
    mocks.profileQueries.push(filters);
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push({ column, value });
        return chain;
      },
      maybeSingle: async () => ({
        data:
          mocks.profiles.find((row) =>
            filters.every(
              (f) => (row as Record<string, unknown>)[f.column] === f.value
            )
          ) ?? null,
        error: null,
      }),
    };
    return chain;
  },
};

const ctx = {
  supabase,
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
  mocks.profiles = [
    { user_id: 'agent-9', account_id: 'account-1' },
    { user_id: 'stranger', account_id: 'account-2' },
  ];
  mocks.profileQueries = [];
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

  // a7.8 §2: the assignee must be a member of the caller's account.
  it('asigna a un miembro de la cuenta, comprobado por user_id y account_id', async () => {
    const res = await PATCH(req({ assigned_agent_id: 'agent-9' }), params);
    expect(res.status).toBe(200);
    expect(mocks.assign).toHaveBeenCalledWith(expect.anything(), 'agent-9');
    expect(mocks.profileQueries).toEqual([
      [
        { column: 'user_id', value: 'agent-9' },
        { column: 'account_id', value: 'account-1' },
      ],
    ]);
  });

  it('400 si el agente es de otra cuenta, sin escribir ni emitir', async () => {
    const res = await PATCH(req({ assigned_agent_id: 'stranger' }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "'assigned_agent_id' is not a member of this account"
    );
    // `assignConversation` is what UPDATEs and emits `conversation.assigned`.
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it('400 si el agente no existe en ninguna cuenta', async () => {
    const res = await PATCH(req({ assigned_agent_id: 'ghost' }), params);
    expect(res.status).toBe(400);
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it('null desasigna sin consultar miembros', async () => {
    const res = await PATCH(req({ assigned_agent_id: null }), params);
    expect(res.status).toBe(200);
    expect(mocks.assign).toHaveBeenCalledWith(expect.anything(), null);
    expect(mocks.profileQueries).toHaveLength(0);
  });
});
