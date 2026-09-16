import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('@/lib/webhooks/emit', () => ({ emitWebhookEvent: mocks.emit }));
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  serializeContact,
  findOrCreateContact,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      // Fase 6 §5: el nombre de usuario y el BSUID viajan en la
      // respuesta pública, null cuando el contacto no los tiene.
      wa_username: null,
      wa_user_id: null,
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  beforeEach(() => {
    mocks.emit.mockReset();
    mocks.emit.mockResolvedValue(undefined);
  });

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });

  // Fase 6 §5.
  it('rechaza un BSUID con formato imposible con un 400 que lo nombra', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { waUserId: 'no-es-un-bsuid' })
    ).rejects.toMatchObject({ status: 400, message: /to_user_id/ });
  });

  it('busca por BSUID y no exige teléfono', async () => {
    const reads: Record<string, unknown>[] = [];
    const db = {
      from: () => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (column: string, value: unknown) => {
            reads.push({ column, value });
            return chain;
          },
          maybeSingle: async () => ({ data: { id: 'c-9' }, error: null }),
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    await expect(
      findOrCreateContact(db, 'acc', 'user', {
        waUserId: 'US.1349700000000001',
      })
    ).resolves.toEqual({ id: 'c-9', created: false });
    // Acotado por cuenta: el cliente de rol de servicio no pasa por RLS.
    expect(reads).toContainEqual({ column: 'account_id', value: 'acc' });
    expect(reads).toContainEqual({
      column: 'wa_user_id',
      value: 'US.1349700000000001',
    });
    // Encontrar no es crear: sin webhook (fase 7 §4).
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('emite contact.created solo en el alta real', async () => {
    const db = {
      from: () => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
          // `findExistingContact` cierra con `.like()`, no con un
          // terminal explícito: la cadena tiene que ser «esperable».
          like: () => Promise.resolve({ data: [], error: null }),
          insert: () => chain,
          single: async () => ({ data: { id: 'c-new' }, error: null }),
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    await expect(
      findOrCreateContact(db, 'acc', 'user', {
        phone: '+14155550123',
        name: 'Jane',
      })
    ).resolves.toEqual({ id: 'c-new', created: true });

    expect(mocks.emit).toHaveBeenCalledWith('acc', 'contact.created', {
      contact_id: 'c-new',
      // El teléfono que viaja es el que se GUARDÓ (saneado para Meta,
      // sin «+»), no el que mandó el cliente.
      phone: '14155550123',
      wa_user_id: null,
      name: 'Jane',
    });
  });
});
