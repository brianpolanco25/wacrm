import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  TAG_ROSTER_SCAN_LIMIT,
  TagError,
  findOrCreateTag,
  findTagByName,
} from './tags';

// ---------------------------------------------------------------------------
// Integración de la fase 7 — `findOrCreateTag` contra el índice único
// que añade la migración 064 (`tags (account_id, lower(name))`).
//
// Aquí NO sirve `fake-supabase.ts`: ese doble no simula restricciones
// únicas, y lo que hay que probar es justo lo que pasa cuando Postgres
// devuelve 23505. Así que el cliente es un doble a medida que apunta las
// consultas (para poder afirmar el `.limit()`) y deja elegir el error del
// INSERT por caso.
//
// La carrera que esto cubre es real, no teórica: el panel
// (`tag-manager.tsx`) inserta en `tags` directo desde el navegador
// mientras la API hace su find-or-create.
// ---------------------------------------------------------------------------

interface Recorded {
  table: string;
  op: 'select' | 'insert';
  filters: Record<string, unknown>;
  limit: number | null;
}

interface FakeOptions {
  /** Filas que devuelve el SELECT, en orden de llamada. */
  reads: Record<string, unknown>[][];
  /** Error que devuelve el INSERT, o null para que funcione. */
  insertError?: { code?: string; message?: string } | null;
  /** Fila que devuelve el INSERT cuando no hay error. */
  insertRow?: Record<string, unknown>;
}

function makeDb(opts: FakeOptions) {
  const log: Recorded[] = [];
  const reads = [...opts.reads];

  function from(table: string) {
    const entry: Recorded = { table, op: 'select', filters: {}, limit: null };
    log.push(entry);

    const builder = {
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        entry.filters[column] = value;
        return builder;
      },
      limit(n: number) {
        entry.limit = n;
        return builder;
      },
      insert(row: Record<string, unknown>) {
        entry.op = 'insert';
        entry.filters = row;
        return builder;
      },
      single() {
        return Promise.resolve(
          opts.insertError
            ? { data: null, error: opts.insertError }
            : { data: opts.insertRow ?? null, error: null }
        );
      },
      // El SELECT sin terminal se resuelve como una lista, igual que
      // PostgREST.
      then(resolve: (value: unknown) => unknown) {
        const data = reads.shift() ?? [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return builder;
  }

  return { db: { from } as unknown as SupabaseClient, log };
}

const ACCOUNT = 'acct-a';
const USER = 'user-a';
const ROW = {
  id: 'tag-1',
  name: 'Moroso',
  color: '#333333',
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('findTagByName', () => {
  it('acota la lectura con un .limit() explícito y por cuenta', async () => {
    const { db, log } = makeDb({ reads: [[ROW]] });

    const found = await findTagByName(db, ACCOUNT, '  moroso ');

    expect(found?.id).toBe('tag-1');
    expect(log).toHaveLength(1);
    expect(log[0].table).toBe('tags');
    expect(log[0].filters).toEqual({ account_id: ACCOUNT });
    // Sin `.limit()` mandaría el `db-max-rows` de PostgREST (1000 por
    // defecto) en silencio y el find-or-create dejaría de ver etiquetas
    // existentes pasada esa línea.
    expect(log[0].limit).toBe(TAG_ROSTER_SCAN_LIMIT);
  });
});

describe('findOrCreateTag frente al índice único (migración 064)', () => {
  it('crea la etiqueta cuando nadie la tiene', async () => {
    const { db, log } = makeDb({ reads: [[]], insertRow: ROW });

    const { tag, created } = await findOrCreateTag(
      db,
      ACCOUNT,
      USER,
      'Moroso',
      '#333333'
    );

    expect(created).toBe(true);
    expect(tag.id).toBe('tag-1');
    expect(log.map((e) => e.op)).toEqual(['select', 'insert']);
    expect(log[1].filters).toMatchObject({
      account_id: ACCOUNT,
      user_id: USER,
      name: 'Moroso',
    });
  });

  it('trata el 23505 del INSERT como find-or-create: relee y devuelve la existente', async () => {
    // Primera lectura: vacía (la otra petición aún no había escrito).
    // INSERT: 23505, porque entre medias sí escribió.
    // Segunda lectura: la fila de la ganadora, con OTRA caja.
    const winner = { ...ROW, id: 'tag-winner', name: 'moroso' };
    const { db, log } = makeDb({
      reads: [[], [winner]],
      insertError: { code: '23505', message: 'duplicate key value' },
    });

    const { tag, created } = await findOrCreateTag(db, ACCOUNT, USER, 'Moroso');

    // 200 con la fila que ya existe, no 500: es exactamente lo que el
    // cliente pidió, solo que lo creó otro primero.
    expect(created).toBe(false);
    expect(tag.id).toBe('tag-winner');
    expect(tag.name).toBe('moroso');
    expect(log.map((e) => e.op)).toEqual(['select', 'insert', 'select']);
    // Y no se reintenta el INSERT: volvería a chocar.
    expect(log.filter((e) => e.op === 'insert')).toHaveLength(1);
  });

  it('si tras el 23505 la relectura no ve la fila, responde 409 en vez de insistir', async () => {
    // Solo alcanzable con un catálogo más largo que el límite de lectura:
    // el índice ve el choque y la relectura no llega a la fila. Mejor un
    // 409 honesto que un bucle de inserciones que chocan.
    const { db, log } = makeDb({
      reads: [[], []],
      insertError: { code: '23505', message: 'duplicate key value' },
    });

    await expect(
      findOrCreateTag(db, ACCOUNT, USER, 'Moroso')
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      findOrCreateTag(
        makeDb({ reads: [[], []], insertError: { code: '23505' } }).db,
        ACCOUNT,
        USER,
        'Moroso'
      )
    ).rejects.toBeInstanceOf(TagError);
    expect(log.filter((e) => e.op === 'insert')).toHaveLength(1);
  });

  it('cualquier otro error del INSERT sigue siendo un 500', async () => {
    const { db } = makeDb({
      reads: [[]],
      insertError: { code: '42501', message: 'permission denied' },
    });

    await expect(
      findOrCreateTag(db, ACCOUNT, USER, 'Moroso')
    ).rejects.toMatchObject({ status: 500 });
  });
});
