import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { addContactTagIfAbsent, removeContactTag } from './tag-write';

interface FakeOptions {
  contact?: { id: string } | null;
  tag?: { id: string } | null;
  insertData?: { id: string } | null;
  insertError?: { code?: string; message: string } | null;
}

function fakeDb(options: FakeOptions = {}): SupabaseClient {
  const contact =
    options.contact === undefined ? { id: 'contact-1' } : options.contact;
  const tag = options.tag === undefined ? { id: 'tag-1' } : options.tag;

  return {
    from(table: string) {
      const state = { operation: 'select' };
      const builder = {
        select() {
          return builder;
        },
        insert() {
          state.operation = 'insert';
          return builder;
        },
        eq() {
          return builder;
        },
        maybeSingle() {
          if (table === 'contacts')
            return Promise.resolve({ data: contact, error: null });
          if (table === 'tags')
            return Promise.resolve({ data: tag, error: null });
          if (table === 'contact_tags' && state.operation === 'insert') {
            return Promise.resolve({
              data:
                options.insertData === undefined
                  ? { id: 'join-1' }
                  : options.insertData,
              error: options.insertError ?? null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const input = {
  accountId: 'account-1',
  contactId: 'contact-1',
  tagId: 'tag-1',
};

describe('addContactTagIfAbsent', () => {
  it('returns true only when the join row was inserted', async () => {
    await expect(addContactTagIfAbsent(fakeDb(), input)).resolves.toBe(true);
  });

  it('treats an error-free insert as successful even without a returned row', async () => {
    await expect(
      addContactTagIfAbsent(fakeDb({ insertData: null }), input)
    ).resolves.toBe(true);
  });

  it('treats a unique violation as an idempotent duplicate', async () => {
    const db = fakeDb({
      insertData: null,
      insertError: { code: '23505', message: 'duplicate key' },
    });
    await expect(addContactTagIfAbsent(db, input)).resolves.toBe(false);
  });

  it('refuses contacts and tags outside the account', async () => {
    await expect(
      addContactTagIfAbsent(fakeDb({ contact: null }), input)
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      addContactTagIfAbsent(fakeDb({ tag: null }), input)
    ).rejects.toMatchObject({ status: 404 });
  });

  it('surfaces non-duplicate insert failures', async () => {
    const db = fakeDb({
      insertData: null,
      insertError: { code: '42501', message: 'permission denied' },
    });
    await expect(addContactTagIfAbsent(db, input)).rejects.toThrow(
      'Failed to add contact tag: permission denied'
    );
  });
});

// ============================================================
// Fase 7 §2 — `removeContactTag` tiene que decir si borró algo.
//
// Deuda que dejó la revisión de a7.4 (`review_webhooks-durable.md`,
// hallazgo 2): devolvía `void`, así que quien la llamaba emitía
// `contact.tag_removed` sin saber si el DELETE alcanzó una fila.
// La base de este doble devuelve las filas borradas, que es lo que hace
// PostgREST cuando la petición pide `.select('id')` — y solo entonces.
// ============================================================

interface RemoveFakeOptions {
  contact?: { id: string } | null;
  tag?: { id: string } | null;
  /** Filas que el DELETE alcanza. `[]` = la etiqueta no estaba puesta. */
  deleted?: { id: string }[];
  deleteError?: { code?: string; message: string } | null;
  /** Recibe `true` si la consulta de borrado pidió las filas de vuelta. */
  onSelect?: (asked: boolean) => void;
}

function fakeRemoveDb(options: RemoveFakeOptions = {}): SupabaseClient {
  const contact =
    options.contact === undefined ? { id: 'contact-1' } : options.contact;
  const tag = options.tag === undefined ? { id: 'tag-1' } : options.tag;

  return {
    from(table: string) {
      const state = { operation: 'select', asked: false };
      const result = () => ({
        data: options.deleted ?? [{ id: 'join-1' }],
        error: options.deleteError ?? null,
      });
      const builder = {
        select() {
          state.asked = true;
          options.onSelect?.(state.operation === 'delete');
          return builder;
        },
        delete() {
          state.operation = 'delete';
          return builder;
        },
        eq() {
          return builder;
        },
        maybeSingle() {
          if (table === 'contacts')
            return Promise.resolve({ data: contact, error: null });
          if (table === 'tags')
            return Promise.resolve({ data: tag, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        // El borrado se espera directamente sobre el constructor, sin
        // terminal: es lo que hace `removeContactTag`.
        then(onFulfilled: (value: unknown) => unknown) {
          // Sin `.select()` PostgREST no devuelve filas. Si alguien
          // quitara esa llamada, `data` sería null y el resultado
          // dejaría de distinguir borrar cero de borrar una.
          return Promise.resolve(
            state.asked ? result() : { data: null, error: null }
          ).then(onFulfilled);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('removeContactTag', () => {
  it('devuelve true cuando el DELETE alcanzó una fila', async () => {
    await expect(removeContactTag(fakeRemoveDb(), input)).resolves.toBe(true);
  });

  it('devuelve false cuando la etiqueta no estaba puesta', async () => {
    await expect(
      removeContactTag(fakeRemoveDb({ deleted: [] }), input)
    ).resolves.toBe(false);
  });

  it('pide las filas de vuelta en la propia consulta de borrado', async () => {
    let askedOnDelete = false;
    await removeContactTag(
      fakeRemoveDb({
        onSelect: (asked) => {
          askedOnDelete = askedOnDelete || asked;
        },
      }),
      input
    );
    expect(askedOnDelete).toBe(true);
  });

  it('sigue refusando contactos y etiquetas de otra cuenta', async () => {
    await expect(
      removeContactTag(fakeRemoveDb({ contact: null }), input)
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      removeContactTag(fakeRemoveDb({ tag: null }), input)
    ).rejects.toMatchObject({ status: 404 });
  });

  it('propaga un fallo del borrado en vez de darlo por hecho', async () => {
    await expect(
      removeContactTag(
        fakeRemoveDb({
          deleted: [],
          deleteError: { code: '42501', message: 'permission denied' },
        }),
        input
      )
    ).rejects.toThrow('Failed to remove contact tag: permission denied');
  });
});
