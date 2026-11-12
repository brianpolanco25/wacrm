import { describe, expect, it } from 'vitest';

import { fixWeekdays, type FixWeekdaysOptions } from './weekday-fix';

// n13.11: red de seguridad del día de la semana en el texto final.

// Jueves 12 de noviembre de 2026.
const TODAY = { year: 2026, month: 11, day: 12 };
const fix = (text: string, today = TODAY, options?: FixWeekdaysOptions) =>
  fixWeekdays(text, today, options);

describe('fixWeekdays — fecha explícita en español', () => {
  it('production case: «Mañana jueves 13 de noviembre» → viernes', () => {
    expect(fix('Mañana jueves 13 de noviembre a las 2:00 p.m.')).toEqual({
      text: 'Mañana viernes 13 de noviembre a las 2:00 p.m.',
      fixes: 1,
      conflicts: 0,
    });
  });

  it('keeps the capital letter', () => {
    expect(fix('Jueves 13 de noviembre').text).toBe('Viernes 13 de noviembre');
  });

  it('keeps all caps', () => {
    expect(fix('JUEVES 13 DE NOVIEMBRE').text).toBe('VIERNES 13 DE NOVIEMBRE');
  });

  it('a right weekday is left intact', () => {
    expect(fix('viernes 13 de noviembre')).toEqual({
      text: 'viernes 13 de noviembre',
      fixes: 0,
      conflicts: 0,
    });
  });

  it('detects with and without accent', () => {
    expect(fix('el miércoles 12 de noviembre').text).toBe(
      'el jueves 12 de noviembre'
    );
    expect(fix('el miercoles 12 de noviembre').text).toBe(
      'el jueves 12 de noviembre'
    );
    expect(fix('jueves 14 de noviembre').text).toBe('sábado 14 de noviembre');
  });

  it('accepts a comma and «el» between weekday and day', () => {
    expect(fix('jueves, el 13 de noviembre').text).toBe(
      'viernes, el 13 de noviembre'
    );
  });

  it('uses the explicit year', () => {
    expect(fix('lunes 15 de diciembre de 2025').fixes).toBe(0);
    expect(fix('martes 16 de diciembre de 2025').fixes).toBe(0);
    expect(fix('martes 15 de diciembre de 2025').text).toBe(
      'lunes 15 de diciembre de 2025'
    );
  });

  it('a date more than 60 days back is next year (year turn)', () => {
    const dec28 = { year: 2026, month: 12, day: 28 };
    expect(fix('lunes 4 de enero', dec28).fixes).toBe(0);
    expect(fix('martes 4 de enero', dec28).text).toBe('lunes 4 de enero');
  });

  it('a date less than 60 days back stays in this year', () => {
    // 1 de noviembre de 2026 es domingo.
    expect(fix('lunes 1 de noviembre').text).toBe('domingo 1 de noviembre');
  });

  it('an invalid date is left intact', () => {
    expect(fix('jueves 31 de noviembre')).toEqual({
      text: 'jueves 31 de noviembre',
      fixes: 0,
      conflicts: 0,
    });
  });

  it('fixes several dates in one text', () => {
    expect(
      fix('Tengo jueves 13 de noviembre o sábado 15 de noviembre.')
    ).toEqual({
      text: 'Tengo viernes 13 de noviembre o domingo 15 de noviembre.',
      fixes: 2,
      conflicts: 0,
    });
  });
});

describe('fixWeekdays — English dates', () => {
  it('«Thursday, November 13» → Friday', () => {
    expect(fix('Thursday, November 13 at 2 pm').text).toBe(
      'Friday, November 13 at 2 pm'
    );
  });

  it('«Thursday 13 November» and ordinals', () => {
    expect(fix('Thursday 13 November').text).toBe('Friday 13 November');
    expect(fix('thursday the 13th of November').text).toBe(
      'friday the 13th of November'
    );
    expect(fix('Thursday, November 13th, 2026').text).toBe(
      'Friday, November 13th, 2026'
    );
  });

  it('a right English weekday is intact', () => {
    expect(fix('Friday, November 13').fixes).toBe(0);
  });
});

describe('fixWeekdays — días relativos', () => {
  it('«mañana jueves» → «mañana viernes»', () => {
    expect(fix('Te espero mañana jueves a las 3.').text).toBe(
      'Te espero mañana viernes a las 3.'
    );
  });

  it('«hoy jueves» is intact', () => {
    expect(fix('hoy jueves')).toMatchObject({ text: 'hoy jueves', fixes: 0 });
  });

  it('«pasado mañana» is today + 2', () => {
    expect(fix('pasado mañana, viernes').text).toBe('pasado mañana, sábado');
  });

  it('English: «tomorrow Thursday» → Friday', () => {
    expect(fix('See you tomorrow, Thursday.').text).toBe(
      'See you tomorrow, Friday.'
    );
  });

  it('«la mañana» / «esta mañana» are the morning, not tomorrow', () => {
    expect(fix('el jueves por la mañana jueves').fixes).toBe(0);
    expect(fix('esta mañana jueves').fixes).toBe(0);
  });

  it('only the weekday changes, never «mañana» nor the number', () => {
    const r = fix('MAÑANA jueves 13 de noviembre');
    expect(r.text).toBe('MAÑANA viernes 13 de noviembre');
  });
});

describe('fixWeekdays — leaves the rest alone', () => {
  it('prices and times are intact', () => {
    const text = 'La consulta cuesta RD$4,000 y es a las 2:00 p.m.';
    expect(fix(text)).toMatchObject({ text, fixes: 0 });
  });

  it('a text without dates → same string, 0 fixes', () => {
    const text = 'Hola, ¿en qué te puedo ayudar? 😀';
    const r = fix(text);
    expect(r.fixes).toBe(0);
    expect(r.text).toBe(text);
  });

  it('a weekday alone (no date, no relative day) is intact', () => {
    expect(fix('El jueves no hay consultas.').fixes).toBe(0);
  });

  it('keeps text around emoji and accents in place', () => {
    expect(fix('😀 Ánimo: jueves 13 de noviembre 👍').text).toBe(
      '😀 Ánimo: viernes 13 de noviembre 👍'
    );
  });
});

describe('fixWeekdays — ronda 2 (review)', () => {
  it('H1: a list or range of days after a relative day is intact', () => {
    for (const text of [
      'A partir de mañana, lunes a viernes, atendemos de 8:00 a.m. a 5:00 p.m.',
      'Tenemos espacio hoy, lunes y sábado',
      'desde mañana lunes hasta viernes',
      'mañana, lunes, martes o miércoles',
      'tomorrow, Monday through Friday',
      'today Monday or Saturday',
    ]) {
      expect(fix(text)).toEqual({ text, fixes: 0, conflicts: 0 });
    }
    // Una sola fecha sigue corrigiéndose.
    expect(fix('mañana, lunes').text).toBe('mañana, viernes');
  });

  it('H2: relative: false only fixes explicit dates', () => {
    expect(fix('mañana jueves', TODAY, { relative: false })).toEqual({
      text: 'mañana jueves',
      fixes: 0,
      conflicts: 0,
    });
    expect(
      fix('mañana jueves 13 de noviembre', TODAY, { relative: false }).text
    ).toBe('mañana viernes 13 de noviembre');
  });

  it('H3: explicit date and relative day disagree → intact, counted', () => {
    expect(fix('mañana viernes 14 de noviembre')).toEqual({
      text: 'mañana viernes 14 de noviembre',
      fixes: 0,
      conflicts: 1,
    });
    expect(fix('mañana jueves 12 de noviembre')).toEqual({
      text: 'mañana jueves 12 de noviembre',
      fixes: 0,
      conflicts: 1,
    });
  });

  it('H4: an implausible explicit year is not a year', () => {
    expect(fix('viernes 13 de noviembre de 1500 pesos')).toEqual({
      text: 'viernes 13 de noviembre de 1500 pesos',
      fixes: 0,
      conflicts: 0,
    });
    expect(fix('jueves 13 de noviembre de 2029').fixes).toBe(0);
    // 13-nov-2028 es lunes: dentro de rango sí se corrige.
    expect(fix('jueves 13 de noviembre de 2028').text).toBe(
      'lunes 13 de noviembre de 2028'
    );
  });

  it('H5: lowercase «may» followed by a word is the verb', () => {
    expect(fix('Friday may 3 people join?').fixes).toBe(0);
    expect(fix('Friday 3 may be fine').fixes).toBe(0);
    // 3-may-2027 es lunes.
    expect(fix('Friday, May 3 people').text).toBe('Monday, May 3 people');
    expect(fix('friday may 3.').text).toBe('monday may 3.');
  });
});
