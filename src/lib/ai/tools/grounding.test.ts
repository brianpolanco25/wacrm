import { describe, expect, it } from 'vitest';

// n13.7 R35: detector de afirmaciones de agenda (es/en).

import { GROUNDING_RETRY_NOTE, mentionsSchedule } from './grounding';

describe('mentionsSchedule (R35)', () => {
  it.each([
    'Tenemos hueco a las 10:30',
    'a las 10.30 le va bien?',
    'a las 10h30',
    'puede venir a las 3 pm',
    'a las 3 p. m.',
    'a las 3pm',
    'at 10 a.m. tomorrow',
    'el Jueves tenemos sitio',
    'el miércoles',
    'el miercoles',
    'EL SÁBADO',
    'How about Monday?',
    'el 12/11',
    'el 2026-11-12',
    'el 12 de noviembre',
    'November 12 works',
    'el 12 nov',
    'on Nov. 12',
  ])('positive: %s', (text) => expect(mentionsSchedule(text)).toBe(true));

  it.each([
    'hoy',
    'mañana',
    'tomorrow',
    'today',
    'Gracias por escribirnos',
    'Su cédula 001-1234567-8',
    'tiene 3 citas',
    'el precio es RD$1,500.00',
    'llame al 809 555 1234',
    '',
  ])('negative: %s', (text) => expect(mentionsSchedule(text)).toBe(false));
});

describe('GROUNDING_RETRY_NOTE', () => {
  it('asks to call the tool or answer without days or times', () => {
    expect(GROUNDING_RETRY_NOTE).toMatch(/call the availability tool/i);
    expect(GROUNDING_RETRY_NOTE).toMatch(
      /without mentioning any day, date or time/
    );
  });
});
