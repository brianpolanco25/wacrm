import { beforeEach, describe, expect, it, vi } from 'vitest';

// i12.1 — POST /api/invitations/[token]/redeem. /join calls it on its own
// (no button), and reads `reason` to say why it failed. The RPC's HINT
// (migration 090) is what becomes `reason`.

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  rpc: { data: 'acct-A' as unknown, error: null as unknown },
  calls: [] as { name: string; args: Record<string, unknown> }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.calls.push({ name, args });
      return h.rpc;
    },
  }),
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, reset: 0 }),
}));

import { hashInviteToken } from '@/lib/auth/invitations';
import { POST } from './route';

function call(token = 'tok-123') {
  return POST(
    new Request(`http://localhost/api/invitations/${token}/redeem`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ token }) }
  );
}

function rpcError(code: string, hint: string | null, message = 'nope') {
  return { data: null, error: { code, hint, message, details: null } };
}

beforeEach(() => {
  h.user = { id: 'user-1' };
  h.rpc = { data: 'acct-A', error: null };
  h.calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/invitations/[token]/redeem', () => {
  it('200 with the account id, and the RPC gets the HASH of the token', async () => {
    const res = await call('tok-123');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accountId: 'acct-A' });
    expect(h.calls).toEqual([
      {
        name: 'redeem_invitation',
        args: { p_token_hash: hashInviteToken('tok-123') },
      },
    ]);
  });

  it.each(['not_found', 'used', 'expired', 'no_seats'])(
    '400 with reason %s from the HINT (22023)',
    async (hint) => {
      h.rpc = rpcError('22023', hint);
      const res = await call();
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'nope', reason: hint });
    }
  );

  it.each(['has_data', 'shared_account'])(
    '409 with reason %s from the HINT (23505)',
    async (hint) => {
      h.rpc = rpcError('23505', hint, 'Your account already contains data');
      const res = await call();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Your account already contains data',
        reason: hint,
      });
    }
  );

  it('400 without a reason when the RPC gave no HINT', async () => {
    h.rpc = rpcError('22023', null);
    const body = await (await call()).json();
    expect(body).toEqual({ error: 'nope' });
  });

  it('401 without a session, and the RPC is never called', async () => {
    h.user = null;
    expect((await call()).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('401 when the RPC says 42501', async () => {
    h.rpc = rpcError('42501', null, 'Unauthorized');
    expect((await call()).status).toBe(401);
  });

  it('500 on an unknown code, without leaking the message', async () => {
    h.rpc = rpcError('XX000', 'internal', 'boom with details');
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to redeem invitation' });
  });
});
