import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/v1/conversations (n15.5): orden por última actividad, filtros,
// búsqueda, ventana de 24 h, estado de la IA y aislamiento por cuenta.

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  db: null as unknown as import('@/lib/security/fake-supabase').FakeDatabase,
}));

vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: h.requireApiKey }));

import { FakeDatabase } from '@/lib/security/fake-supabase';
import { GET } from './route';

const A = 'acct-a';
const B = 'acct-b';
const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AGENT = ID(900);

function conv(
  n: number,
  account: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: ID(n),
    account_id: account,
    contact_id: ID(100 + n),
    status: 'open',
    assigned_agent_id: null,
    last_message_text: `m${n}`,
    last_message_at: `2026-03-0${n}T10:00:00.000Z`,
    last_inbound_at: null,
    unread_count: 0,
    ai_autoreply_disabled: false,
    ai_handoff_summary: null,
    created_at: `2026-01-0${n}T00:00:00.000Z`,
    updated_at: `2026-03-0${n}T10:00:00.000Z`,
    ...over,
  };
}

function seed(): FakeDatabase {
  return new FakeDatabase({
    conversations: [
      // Creada primero pero con la actividad más reciente.
      conv(1, A, {
        last_message_at: '2026-03-09T10:00:00.000Z',
        unread_count: 3,
        last_inbound_at: '2026-03-09T10:00:00.000Z',
      }),
      conv(2, A, { assigned_agent_id: AGENT, unread_count: 1 }),
      conv(3, A),
      conv(4, A, { last_message_at: null, last_message_text: null }),
      conv(5, B, {
        last_message_at: '2026-04-01T00:00:00.000Z',
        unread_count: 9,
      }),
    ],
    contacts: [
      { id: ID(101), account_id: A, name: 'Ana Pérez', phone: '+18095550101' },
      { id: ID(102), account_id: A, name: 'Beto', phone: '+18095550102' },
      { id: ID(103), account_id: A, name: 'Cleo', phone: '+18095550103' },
      { id: ID(104), account_id: A, name: 'Dani', phone: '+18095550104' },
      { id: ID(105), account_id: B, name: 'Ana Ajena', phone: '+18095550199' },
    ],
    ai_configs: [
      { id: 'cfg-a', account_id: A, is_active: true, auto_reply_enabled: true },
      {
        id: 'cfg-b',
        account_id: B,
        is_active: false,
        auto_reply_enabled: false,
      },
    ],
  });
}

function key(accountId: string) {
  return {
    authType: 'api_key',
    supabase: h.db.admin,
    accountId,
    keyId: `key-${accountId}`,
    scopes: ['conversations:read'],
    createdBy: null,
  };
}

const get = async (qs = '') => {
  const res = await GET(
    new Request(`https://crm.test/api/v1/conversations${qs}`)
  );
  return { res, body: await res.json() };
};
const ids = (body: { data: { id: string }[] }) =>
  body.data.map((c) => Number(c.id.slice(-3)));

beforeEach(() => {
  h.db = seed();
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue(key(A));
});

describe('GET /api/v1/conversations', () => {
  it('exige conversations:read y por defecto ordena por creación', async () => {
    const { body } = await get();
    expect(h.requireApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'conversations:read'
    );
    expect(ids(body)).toEqual([4, 3, 2, 1]);
  });

  it('sort=last_activity ordena por último mensaje y deja al final las sin mensajes', async () => {
    const { body } = await get('?sort=last_activity');
    expect(ids(body)).toEqual([1, 3, 2, 4]);
  });

  it('pagina por actividad sin repetir ni saltar, incluida la zona sin mensajes', async () => {
    const seen: number[] = [];
    let cursor = '';
    for (let i = 0; i < 4; i++) {
      const { body } = await get(`?sort=last_activity&limit=1${cursor}`);
      seen.push(...ids(body));
      if (!body.meta.next_cursor) break;
      cursor = `&cursor=${body.meta.next_cursor}`;
    }
    expect(seen).toEqual([1, 3, 2, 4]);
  });

  it('filtra por asignado (id o none) y por no leídas', async () => {
    expect(ids((await get(`?assigned_agent_id=${AGENT}`)).body)).toEqual([2]);
    expect(ids((await get('?assigned_agent_id=none')).body)).toEqual([4, 3, 1]);
    expect(ids((await get('?unread=true&sort=last_activity')).body)).toEqual([
      1, 2,
    ]);
  });

  it('busca por nombre o teléfono del contacto, solo en la cuenta de la clave', async () => {
    expect(ids((await get('?search=ana')).body)).toEqual([1]);
    expect(ids((await get('?search=0102')).body)).toEqual([2]);
    expect((await get('?search=nadie')).body.data).toEqual([]);
  });

  it('rechaza valores inválidos con 400', async () => {
    expect((await get('?sort=raro')).res.status).toBe(400);
    expect((await get('?assigned_agent_id=no-es-uuid')).res.status).toBe(400);
    expect((await get('?unread=quizas')).res.status).toBe(400);
  });

  it('informa la ventana de 24 h y el estado de la IA', async () => {
    const { body } = await get('?sort=last_activity');
    const first = body.data[0];
    expect(first.last_inbound_at).toBe('2026-03-09T10:00:00.000Z');
    expect(first.service_window_expires_at).toBe('2026-03-10T10:00:00.000Z');
    expect(first.ai).toEqual({
      active: true,
      paused: false,
      handoff_summary: null,
    });
    const assigned = body.data.find((c: { id: string }) => c.id === ID(2));
    expect(assigned.service_window_expires_at).toBeNull();
    expect(assigned.ai.active).toBe(false);
  });

  it('la IA no está activa si la cuenta no la tiene encendida', async () => {
    h.requireApiKey.mockResolvedValue(key(B));
    const { body } = await get();
    expect(body.data[0].ai.active).toBe(false);
  });

  it('nunca mezcla cuentas, ni siquiera con filtros y búsqueda', async () => {
    const all = JSON.stringify((await get('?sort=last_activity')).body);
    expect(all).not.toContain('Ajena');
    expect(ids((await get('?unread=true')).body)).not.toContain(5);

    h.requireApiKey.mockResolvedValue(key(B));
    expect(ids((await get()).body)).toEqual([5]);
    expect(ids((await get('?search=ana')).body)).toEqual([5]);
  });
});
