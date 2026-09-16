import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveImportTagIds } from './resolve-import-tags';

// ---------------------------------------------------------------------------
// Integración de la fase 7 — la importación de CSV frente al índice único
// que añade la migración 064 (`tags (account_id, lower(name))`).
//
// La importación lee el catálogo, decide qué nombres faltan y los inserta
// en un solo INSERT. Con el índice puesto, ese lote puede volver con
// 23505 si entre la lectura y la escritura alguien creó uno de esos
// nombres (otra importación, el panel, `POST /api/v1/tags`). Postgres
// aborta el INSERT ENTERO, así que sin tratarlo la importación completa
// moriría por una etiqueta que, además, ya existe.
//
// El doble de `fake-supabase.ts` no simula índices únicos, así que el
// cliente de aquí es a medida: permite elegir qué devuelve cada lectura y
// qué error devuelve el INSERT.
// ---------------------------------------------------------------------------

const ACCOUNT = 'acct-a';
const USER = 'user-a';

function makeDb(opts: {
  reads: { id: string; name: string }[][];
  insertError?: { code?: string; message?: string } | null;
  inserted?: { id: string; name: string }[];
}) {
  const reads = [...opts.reads];
  let inserts = 0;

  function from() {
    let isInsert = false;
    const builder = {
      select() {
        return builder;
      },
      eq() {
        return builder;
      },
      insert() {
        isInsert = true;
        inserts += 1;
        return builder;
      },
      then(resolve: (value: unknown) => unknown) {
        const result = isInsert
          ? {
              data: opts.insertError ? null : (opts.inserted ?? []),
              error: opts.insertError ?? null,
            }
          : { data: reads.shift() ?? [], error: null };
        return Promise.resolve(result).then(resolve);
      },
    };
    return builder;
  }

  return {
    db: { from } as unknown as SupabaseClient,
    inserts: () => inserts,
  };
}

describe('resolveImportTagIds frente al índice único (migración 064)', () => {
  it('reutiliza la etiqueta que ya existe, aunque venga con otra caja', async () => {
    const { db, inserts } = makeDb({
      reads: [[{ id: 'tag-1', name: 'Moroso' }]],
    });

    const { tagIdByKey, skippedNames } = await resolveImportTagIds(db, {
      accountId: ACCOUNT,
      userId: USER,
      tagNames: ['moroso'],
      canCreateTags: true,
    });

    expect(tagIdByKey.get('moroso')).toBe('tag-1');
    expect(skippedNames).toEqual([]);
    // Nada que crear: sin esto, el INSERT chocaría con el índice.
    expect(inserts()).toBe(0);
  });

  it('un 23505 del lote no tumba la importación: relee y resuelve con lo que hay', async () => {
    const { db, inserts } = makeDb({
      // 1.ª lectura: el catálogo no tiene ninguno de los dos nombres.
      // INSERT: 23505 — otra petición creó «moroso» entre medias.
      // 2.ª lectura: ahí está el de la ganadora.
      reads: [[], [{ id: 'tag-winner', name: 'Moroso' }]],
      insertError: { code: '23505', message: 'duplicate key value' },
    });

    const { tagIdByKey, skippedNames } = await resolveImportTagIds(db, {
      accountId: ACCOUNT,
      userId: USER,
      tagNames: ['moroso', 'vip'],
      canCreateTags: true,
    });

    // El nombre que chocó se resuelve a la fila que ya existe…
    expect(tagIdByKey.get('moroso')).toBe('tag-winner');
    // …y el que nadie llegó a crear se informa como omitido, en vez de
    // abortar la importación entera de contactos.
    expect(skippedNames).toEqual(['vip']);
    // Y no se reintenta el INSERT: volvería a chocar.
    expect(inserts()).toBe(1);
  });

  it('cualquier otro error del INSERT sigue propagándose', async () => {
    const { db } = makeDb({
      reads: [[]],
      insertError: { code: '42501', message: 'permission denied' },
    });

    await expect(
      resolveImportTagIds(db, {
        accountId: ACCOUNT,
        userId: USER,
        tagNames: ['moroso'],
        canCreateTags: true,
      })
    ).rejects.toMatchObject({ code: '42501' });
  });
});
