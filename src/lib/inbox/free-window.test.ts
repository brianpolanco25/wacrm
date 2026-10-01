import { describe, it, expect } from 'vitest';
import { freeWindowUntil } from './free-window';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe('freeWindowUntil (R17, R21)', () => {
  it('R17: una ventana futura en una cuenta direct devuelve su fecha', () => {
    const until = iso(NOW + 3600_000);
    const d = freeWindowUntil({ free_window_until: until }, NOW, 'direct');
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe(until);
  });

  it('R17: una ventana pasada devuelve null', () => {
    expect(
      freeWindowUntil({ free_window_until: iso(NOW - 1) }, NOW, 'direct')
    ).toBeNull();
  });

  it('R17: una ventana que termina justo ahora devuelve null', () => {
    expect(
      freeWindowUntil({ free_window_until: iso(NOW) }, NOW, 'direct')
    ).toBeNull();
  });

  it('R17: NULL o ausente devuelve null', () => {
    expect(
      freeWindowUntil({ free_window_until: null }, NOW, 'direct')
    ).toBeNull();
    expect(freeWindowUntil({}, NOW, 'direct')).toBeNull();
    expect(
      freeWindowUntil({ free_window_until: '' }, NOW, 'direct')
    ).toBeNull();
  });

  it('R17: una cadena inválida devuelve null', () => {
    expect(
      freeWindowUntil({ free_window_until: 'mañana' }, NOW, 'direct')
    ).toBeNull();
  });

  it('R21: en una cuenta managed no hay insignia', () => {
    expect(
      freeWindowUntil(
        { free_window_until: iso(NOW + 3600_000) },
        NOW,
        'managed'
      )
    ).toBeNull();
  });

  it('R21: mientras metaBilling no se conozca no hay insignia', () => {
    expect(
      freeWindowUntil(
        { free_window_until: iso(NOW + 3600_000) },
        NOW,
        undefined
      )
    ).toBeNull();
  });
});
