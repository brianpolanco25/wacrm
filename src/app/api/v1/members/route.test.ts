import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/v1/members: forma, scope, paginación y aislamiento por cuenta. La
// base es el doble en memoria (`fake-supabase`): un `.eq('account_id', …)`
// ausente devolvería aquí los perfiles de la otra cuenta.

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: h.requireApiKey,
}));

import { FakeDatabase } from '@/lib/security/fake-supabase';
import { GET } from './route';

const A = 'acct-a';
const B = 'acct-b';

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function profile(
  n: number,
  account: string,
  role: string,
  created: string,
  name: string
) {
  return {
    id: ID(n),
    user_id: `user-${n}`,
    account_id: account,
    account_role: role,
    full_name: name,
    email: `${name.toLowerCase()}@test.dev`,
    avatar_url: 'https://cdn.test/secret-avatar.png',
    created_at: created,
  };
}

function seed(): FakeDatabase {
  return new FakeDatabase({
    accounts: [
      { id: A, name: 'Alpha', owner_user_id: 'user-1' },
      { id: B, name: 'Beta', owner_user_id: 'user-9' },
    ],
    profiles: [
      profile(1, A, 'owner', '2026-01-01T00:00:00.000Z', 'Ana'),
      profile(2, A, 'agent', '2026-02-01T00:00:00.000Z', 'Beto'),
      profile(3, A, 'viewer', '2026-03-01T00:00:00.000Z', 'Cleo'),
      profile(9, B, 'admin', '2026-02-15T00:00:00.000Z', 'Zoe'),
    ],
  });
}

function key(accountId: string) {
  return {
    authType: 'api_key',
    supabase: h.db.admin,
    accountId,
    keyId: `key-${accountId}`,
    scopes: ['members:read'],
    createdBy: null,
  };
}

beforeEach(() => {
  h.db = seed();
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue(key(A));
});

describe('GET /api/v1/members', () => {
  it('lista solo los miembros de la cuenta de la clave, con user_id como id', async () => {
    const res = await GET(new Request('https://crm.test/api/v1/members'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      {
        id: 'user-3',
        full_name: 'Cleo',
        email: 'cleo@test.dev',
        role: 'viewer',
      },
      {
        id: 'user-2',
        full_name: 'Beto',
        email: 'beto@test.dev',
        role: 'agent',
      },
      { id: 'user-1', full_name: 'Ana', email: 'ana@test.dev', role: 'owner' },
    ]);
    expect(body.meta.next_cursor).toBeNull();
  });

  it('nunca devuelve campos fuera del contrato ni datos de otra cuenta', async () => {
    const raw = JSON.stringify(
      await (await GET(new Request('https://crm.test/api/v1/members'))).json()
    );
    expect(raw).not.toContain('Zoe');
    expect(raw).not.toContain('user-9');
    expect(raw).not.toContain('avatar');
    expect(raw).not.toContain('account_id');
  });

  it('con la clave de la otra cuenta ve solo la suya', async () => {
    h.requireApiKey.mockResolvedValue(key(B));
    const body = await (
      await GET(new Request('https://crm.test/api/v1/members'))
    ).json();
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(['user-9']);
  });

  it('exige el scope members:read', async () => {
    await GET(new Request('https://crm.test/api/v1/members'));
    expect(h.requireApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'members:read'
    );
  });

  it('pagina por cursor sin repetir ni mezclar cuentas', async () => {
    const first = await (
      await GET(new Request('https://crm.test/api/v1/members?limit=2'))
    ).json();
    expect(first.data.map((m: { id: string }) => m.id)).toEqual([
      'user-3',
      'user-2',
    ]);
    expect(first.meta.next_cursor).toBeTruthy();

    const second = await (
      await GET(
        new Request(
          `https://crm.test/api/v1/members?limit=2&cursor=${first.meta.next_cursor}`
        )
      )
    ).json();
    expect(second.data.map((m: { id: string }) => m.id)).toEqual(['user-1']);
    expect(second.meta.next_cursor).toBeNull();
  });
});
