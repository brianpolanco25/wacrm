import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  state: {
    updates: null as Record<string, unknown> | null,
    filters: [] as [string, unknown][],
    row: null as Record<string, unknown> | null,
  },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));

import { DELETE, PATCH } from './route';

function supabaseMock() {
  return {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        delete: () => chain,
        eq: (col: string, val: unknown) => {
          mocks.state.filters.push([col, val]);
          return chain;
        },
        update: (row: Record<string, unknown>) => {
          mocks.state.updates = row;
          return chain;
        },
        maybeSingle: async () => ({ data: mocks.state.row, error: null }),
      };
      return chain;
    },
  };
}

const params = { params: Promise.resolve({ id: 'wh-1' }) };

function req(body: unknown) {
  return new Request('http://localhost/api/account/webhooks/wh-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.state.updates = null;
  mocks.state.filters = [];
  mocks.state.row = {
    id: 'wh-1',
    url: 'https://hook.example.com/in',
    events: ['message.received'],
    is_active: true,
    last_delivery_at: null,
    failure_count: 0,
    created_at: '2026-09-01T00:00:00Z',
  };
  mocks.requireRole.mockReset().mockResolvedValue({
    supabase: supabaseMock(),
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
  });
});

describe('/api/account/webhooks/[id]', () => {
  it('actualiza acotando por id Y por cuenta', async () => {
    const res = await PATCH(
      req({ url: 'https://otro.example.com/in' }),
      params
    );
    expect(res.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.state.filters).toContainEqual(['id', 'wh-1']);
    expect(mocks.state.filters).toContainEqual(['account_id', 'acct-1']);
  });

  it('reactivar limpia la racha de fallos', async () => {
    await PATCH(req({ is_active: true }), params);
    expect(mocks.state.updates).toEqual({ is_active: true, failure_count: 0 });
  });

  it('desactivar no la toca', async () => {
    await PATCH(req({ is_active: false }), params);
    expect(mocks.state.updates).toEqual({ is_active: false });
  });

  it('404 cuando el id no es de la cuenta', async () => {
    mocks.state.row = null;
    expect((await PATCH(req({ is_active: false }), params)).status).toBe(404);
    expect((await DELETE(new Request('http://localhost'), params)).status).toBe(
      404
    );
  });

  it('400 sin campos actualizables, sin tocar la fila', async () => {
    const res = await PATCH(req({ foo: 1 }), params);
    expect(res.status).toBe(400);
    expect(mocks.state.updates).toBeNull();
  });

  it('borra acotando por cuenta', async () => {
    mocks.state.row = { id: 'wh-1' };
    const res = await DELETE(new Request('http://localhost'), params);
    expect(res.status).toBe(200);
    expect(mocks.state.filters).toContainEqual(['account_id', 'acct-1']);
  });
});
