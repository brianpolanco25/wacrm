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
    // ronda 2: horas españolas sin minutos
    'Le agendo mañana a las 4 de la tarde',
    'a las 4',
    'Puede venir a las 4?',
    'a las 10 de la mañana',
    'a las 10 de la manana le va bien',
    'a la 1',
    'a la 1 en punto',
    'a las 3 y media',
    'a las 4 le esperamos',
    'a las 8 o a las 9',
    'nos vemos a las 4, ¿le parece?',
    '3 de la tarde',
    'quedamos 9 de la noche',
    'a las 12 del mediodía',
    'el 4 de noviembre',
    // un día real junto a la ciudad sigue contando
    'el domingo en Santo Domingo',
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
    // ronda 2: «Santo Domingo» no es un día
    'Estamos en la Av. Churchill, Santo Domingo.',
    'Sucursal en Santo Domingo Este',
    'SANTO DOMINGO NORTE',
    'Santo Domingo Oeste, frente al parque',
    'Sto. Domingo',
    // ronda 2: precios con moneda, con o sin espacio
    'La consulta cuesta RD$ 15.00',
    'Cuesta US$ 2.50',
    'son $ 3.50',
    'son $3.50',
    'USD 15.00 por sesión',
    'RD$15.00',
    'DOP 12.30',
    '€ 10.30',
    // ronda 2: números que no son horas
    'atendemos a las 3 personas',
    'a las 2 mascotas',
    'tiene 2 de 3 citas',
    'le quedan 4 de 10 sesiones',
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
