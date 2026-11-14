import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/v1/numbers: forma, scope y aislamiento por cuenta. La base es el
// doble en memoria (`fake-supabase`): un `.eq('account_id', …)` ausente
// devolvería aquí las filas de la otra cuenta.

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

function seed(): FakeDatabase {
  return new FakeDatabase({
    accounts: [
      { id: B, name: 'Beta', owner_user_id: 'user-b' },
      { id: A, name: 'Alpha', owner_user_id: 'user-a' },
    ],
    whatsapp_config: [
      {
        id: 'cfg-b',
        account_id: B,
        phone_number_id: 'PNID-B',
        display_phone_number: '+1 555 000 0002',
        verified_name: 'Beta Clinic',
        is_default: true,
        access_token: 'SECRET-B',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'cfg-a2',
        account_id: A,
        phone_number_id: 'PNID-A2',
        display_phone_number: '+1 555 000 0011',
        verified_name: null,
        is_default: false,
        access_token: 'SECRET-A2',
        created_at: '2026-03-01T00:00:00.000Z',
      },
      {
        id: 'cfg-a1',
        account_id: A,
        phone_number_id: 'PNID-A1',
        display_phone_number: '+1 555 000 0001',
        verified_name: 'Alpha Clinic',
        is_default: true,
        access_token: 'SECRET-A1',
        created_at: '2026-02-01T00:00:00.000Z',
      },
    ],
  });
}

beforeEach(() => {
  h.db = seed();
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue({
    authType: 'api_key',
    supabase: h.db.admin,
    accountId: A,
    keyId: 'key-a',
    scopes: ['messages:send'],
    createdBy: null,
  });
});

describe('GET /api/v1/numbers', () => {
  it('lista solo los números de la cuenta de la clave, el predeterminado primero', async () => {
    const res = await GET(new Request('https://crm.test/api/v1/numbers'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      {
        phone_number_id: 'PNID-A1',
        display_phone_number: '+1 555 000 0001',
        verified_name: 'Alpha Clinic',
        is_default: true,
      },
      {
        phone_number_id: 'PNID-A2',
        display_phone_number: '+1 555 000 0011',
        verified_name: null,
        is_default: false,
      },
    ]);
  });

  it('nunca devuelve tokens ni datos de otra cuenta', async () => {
    const res = await GET(new Request('https://crm.test/api/v1/numbers'));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('PNID-B');
    expect(raw).not.toContain('access_token');
  });

  it('exige el scope messages:send', async () => {
    await GET(new Request('https://crm.test/api/v1/numbers'));
    expect(h.requireApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'messages:send'
    );
  });

  it('con la clave de la otra cuenta ve solo la suya', async () => {
    h.requireApiKey.mockResolvedValue({
      authType: 'api_key',
      supabase: h.db.admin,
      accountId: B,
      keyId: 'key-b',
      scopes: ['messages:send'],
      createdBy: null,
    });
    const body = await (
      await GET(new Request('https://crm.test/api/v1/numbers'))
    ).json();
    expect(
      body.data.map((n: { phone_number_id: string }) => n.phone_number_id)
    ).toEqual(['PNID-B']);
  });
});
