import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FREE_WINDOW_HOURS,
  FREE_WINDOW_SOURCES,
  computeEntryPoint,
  parseReferral,
  recordEntryPoint,
  type EntryPoint,
} from './entry-point';

const NOW_MS = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01T12:00:00Z
const NOW_S = NOW_MS / 1000;
const H72_MS = 72 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseReferral (R5, R6, R7)', () => {
  it("R5: source_type 'ad' da ctwa_ad", () => {
    expect(parseReferral({ source_type: 'ad' })?.source).toBe('ctwa_ad');
  });

  it("R5: source_type 'post' da ctwa_organic", () => {
    expect(parseReferral({ source_type: 'post' })?.source).toBe('ctwa_organic');
  });

  it('R5: se lee en minúsculas y recortado', () => {
    expect(parseReferral({ source_type: '  AD ' })?.source).toBe('ctwa_ad');
  });

  it('R5: otro valor o su ausencia da ctwa_other', () => {
    expect(parseReferral({ source_type: 'page' })?.source).toBe('ctwa_other');
    expect(parseReferral({})?.source).toBe('ctwa_other');
    expect(parseReferral({ source_type: 7 })?.source).toBe('ctwa_other');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['cadena', 'ad'],
    ['número', 42],
    ['array', [{ source_type: 'ad' }]],
    ['booleano', true],
  ])('R6: %s devuelve null sin lanzar', (_label, raw) => {
    expect(() => parseReferral(raw)).not.toThrow();
    expect(parseReferral(raw)).toBeNull();
  });

  it('R7: conserva solo la lista blanca de cadenas, truncadas a 500', () => {
    const long = 'x'.repeat(2000);
    const parsed = parseReferral({
      source_type: 'ad',
      source_id: 12345,
      source_url: 'https://fb.me/abc',
      headline: long,
      ctwa_clid: 'clid-1',
      body: 'texto del anuncio',
      media_type: 'image',
      image_url: 'https://scontent.example/img.jpg',
      video_url: 'https://scontent.example/v.mp4',
      thumbnail_url: 'https://scontent.example/t.jpg',
      nested: { a: 1 },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.referral).toEqual({
      source_type: 'ad',
      source_url: 'https://fb.me/abc',
      headline: 'x'.repeat(500),
      ctwa_clid: 'clid-1',
    });
    expect(parsed!.referral).not.toHaveProperty('source_id');
  });
});

describe('computeEntryPoint (R8, R9, R10)', () => {
  const ad = parseReferral({ source_type: 'ad', source_id: '1' })!;

  it('R8: anuncio con timestamp válido abre la ventana de 72 h exactas', () => {
    const ts = NOW_S - 60;
    const ep = computeEntryPoint(ad, String(ts), NOW_MS);
    expect(ep.entry_point_source).toBe('ctwa_ad');
    expect(ep.entry_point_at).toBe(new Date(ts * 1000).toISOString());
    expect(ep.free_window_until).toBe(
      new Date(ts * 1000 + H72_MS).toISOString()
    );
    expect(
      Date.parse(ep.free_window_until!) - Date.parse(ep.entry_point_at)
    ).toBe(FREE_WINDOW_HOURS * 3600 * 1000);
    expect(ep.entry_point_referral).toEqual({
      source_type: 'ad',
      source_id: '1',
    });
  });

  it('R8: acepta hasta 5 min de adelanto del reloj de Meta', () => {
    const ts = NOW_S + 300;
    const ep = computeEntryPoint(ad, String(ts), NOW_MS);
    expect(ep.free_window_until).toBe(
      new Date(ts * 1000 + H72_MS).toISOString()
    );
  });

  it('R9: orgánico guarda origen y entrada sin ventana', () => {
    const organic = parseReferral({ source_type: 'post' })!;
    const ts = NOW_S - 10;
    const ep = computeEntryPoint(organic, String(ts), NOW_MS);
    expect(ep).toMatchObject({
      entry_point_source: 'ctwa_organic',
      entry_point_at: new Date(ts * 1000).toISOString(),
      free_window_until: null,
    });
  });

  it('R9: ctwa_other guarda origen y entrada sin ventana', () => {
    const other = parseReferral({ source_type: 'weird' })!;
    const ep = computeEntryPoint(other, String(NOW_S), NOW_MS);
    expect(ep.entry_point_source).toBe('ctwa_other');
    expect(ep.free_window_until).toBeNull();
  });

  it('solo los anuncios abren ventana (S-E2)', () => {
    expect(FREE_WINDOW_SOURCES).toEqual(['ctwa_ad']);
  });

  it.each([
    ['abc', 'abc'],
    ['cadena vacía', ''],
    ['negativo', '-1'],
    ['futuro +1 h', String(NOW_S + 3600)],
    ['futuro +301 s', String(NOW_S + 301)],
    ['decimal', '1700000000.5'],
    ['Infinity', 'Infinity'],
    ['undefined', undefined],
    ['null', null],
    ['objeto', { s: 1 }],
    ['enorme', '9'.repeat(400)],
  ])(
    'R10: timestamp %s usa la hora de recepción y no abre ventana',
    (_l, ts) => {
      let ep: EntryPoint | undefined;
      expect(() => {
        ep = computeEntryPoint(ad, ts, NOW_MS);
      }).not.toThrow();
      expect(ep).toMatchObject({
        entry_point_source: 'ctwa_ad',
        entry_point_at: new Date(NOW_MS).toISOString(),
        free_window_until: null,
      });
    }
  );
});

/** Cliente falso: graba la cadena `update().eq().eq().is|eq()`. */
function fakeAdmin(
  outcome: { error?: { message: string } | null; throws?: Error } = {}
) {
  const calls: {
    table: string;
    values: Record<string, unknown>;
    filters: [string, string, unknown][];
  }[] = [];
  const admin = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          const call = {
            table,
            values,
            filters: [] as [string, string, unknown][],
          };
          calls.push(call);
          const chain = {
            eq(col: string, v: unknown) {
              call.filters.push(['eq', col, v]);
              return chain;
            },
            is(col: string, v: unknown) {
              call.filters.push(['is', col, v]);
              return chain;
            },
            then(
              resolve: (r: unknown) => unknown,
              reject: (e: unknown) => unknown
            ) {
              if (outcome.throws) return reject(outcome.throws);
              return resolve({ error: outcome.error ?? null });
            },
          };
          return chain;
        },
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

const EP: EntryPoint = {
  entry_point_source: 'ctwa_ad',
  entry_point_at: '2026-10-01T11:59:00.000Z',
  free_window_until: '2026-10-04T11:59:00.000Z',
  entry_point_referral: { source_type: 'ad' },
};

describe('recordEntryPoint (R11, R14, R16)', () => {
  it('sin valor previo: UPDATE filtrado por id, account_id e is(null)', async () => {
    const { admin, calls } = fakeAdmin();
    await recordEntryPoint(admin, 'acc-A', 'conv-1', null, EP);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('conversations');
    expect(calls[0].values).toEqual({
      entry_point_source: 'ctwa_ad',
      entry_point_at: EP.entry_point_at,
      free_window_until: EP.free_window_until,
      entry_point_referral: { source_type: 'ad' },
    });
    expect(calls[0].filters).toEqual([
      ['eq', 'id', 'conv-1'],
      ['eq', 'account_id', 'acc-A'],
      ['is', 'entry_point_at', null],
    ]);
  });

  it('con valor previo más viejo: filtro optimista eq sobre el leído', async () => {
    const { admin, calls } = fakeAdmin();
    const prev = '2026-09-20T00:00:00.000Z';
    await recordEntryPoint(admin, 'acc-A', 'conv-1', prev, EP);
    expect(calls).toHaveLength(1);
    expect(calls[0].filters).toEqual([
      ['eq', 'id', 'conv-1'],
      ['eq', 'account_id', 'acc-A'],
      ['eq', 'entry_point_at', prev],
    ]);
  });

  it('con valor previo más nuevo o igual: no escribe', async () => {
    const { admin, calls } = fakeAdmin();
    await recordEntryPoint(
      admin,
      'acc-A',
      'conv-1',
      '2026-10-01T12:30:00.000Z',
      EP
    );
    await recordEntryPoint(admin, 'acc-A', 'conv-1', EP.entry_point_at, EP);
    expect(calls).toHaveLength(0);
  });

  it('con valor previo ilegible: no escribe', async () => {
    const { admin, calls } = fakeAdmin();
    await recordEntryPoint(admin, 'acc-A', 'conv-1', 'no-es-fecha', EP);
    expect(calls).toHaveLength(0);
  });

  it('R14: error de Supabase -> console.error de una línea, sin lanzar ni filtrar el referral', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin({ error: { message: 'boom' } });
    await expect(
      recordEntryPoint(admin, 'acc-A', 'conv-1', null, {
        ...EP,
        entry_point_referral: { headline: 'SECRETO' },
      })
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(
      '[webhook] entry point update failed:',
      'boom'
    );
    expect(JSON.stringify(err.mock.calls)).not.toContain('SECRETO');
  });

  it('R14: excepción del cliente -> console.error, sin lanzar', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin({ throws: new Error('network down') });
    await expect(
      recordEntryPoint(admin, 'acc-A', 'conv-1', null, EP)
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(
      '[webhook] entry point update failed:',
      'network down'
    );
  });

  it('R14: un from() que lanza de forma síncrona tampoco escapa', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const admin = {
      from() {
        throw new Error('sync');
      },
    } as unknown as SupabaseClient;
    await expect(
      recordEntryPoint(admin, 'acc-A', 'conv-1', null, EP)
    ).resolves.toBeUndefined();
  });

  it('R16: el account_id del llamante siempre va en el filtro', async () => {
    const { admin, calls } = fakeAdmin();
    await recordEntryPoint(admin, 'acc-B', 'conv-A', null, EP);
    expect(calls[0].filters).toContainEqual(['eq', 'account_id', 'acc-B']);
    expect(calls[0].filters).toContainEqual(['eq', 'id', 'conv-A']);
  });
});
