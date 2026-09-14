import { describe, expect, it } from 'vitest';

import {
  contactDisplayName,
  contactHandle,
  contactMatchesSearch,
} from './display';

// Fase 6 §5. El hueco del teléfono lo rellena esta lógica y solo esta,
// para que bandeja, contactos y difusiones digan lo mismo.

describe('contactHandle', () => {
  it('enseña el teléfono cuando lo hay', () => {
    expect(contactHandle({ phone: '+14155550123', wa_username: 'ada' })).toBe(
      '+14155550123'
    );
  });

  it('enseña «@usuario» cuando no hay teléfono', () => {
    expect(contactHandle({ phone: null, wa_username: 'ada' })).toBe('@ada');
  });

  it('devuelve null cuando no hay nada que enseñar', () => {
    // Quien pinta decide el texto del hueco; aquí no se traduce.
    expect(contactHandle({ phone: null, wa_username: null })).toBeNull();
    expect(contactHandle(null)).toBeNull();
  });

  it('nunca enseña el BSUID: no le dice nada a nadie', () => {
    expect(
      contactHandle({
        phone: null,
        wa_username: null,
        // @ts-expect-error — a propósito: aunque llegue, se ignora.
        wa_user_id: 'US.1349700000000001',
      })
    ).toBeNull();
  });
});

describe('contactDisplayName', () => {
  it('prefiere el nombre guardado', () => {
    expect(
      contactDisplayName({ name: 'Ada', phone: '+1415' }, 'Sin número')
    ).toBe('Ada');
  });

  it('cae al identificador visible y luego al texto del llamante', () => {
    expect(contactDisplayName({ phone: null, wa_username: 'ada' }, 'x')).toBe(
      '@ada'
    );
    expect(contactDisplayName({ phone: null }, 'Sin número')).toBe(
      'Sin número'
    );
  });

  it('ignora un nombre que es solo espacios', () => {
    expect(contactDisplayName({ name: '   ', phone: '+1415' }, 'x')).toBe(
      '+1415'
    );
  });
});

describe('contactMatchesSearch', () => {
  const ada = { name: 'Ada Lovelace', phone: null, wa_username: 'ada_l' };

  it('encuentra por nombre de usuario, con arroba o sin ella', () => {
    expect(contactMatchesSearch(ada, 'ada_l')).toBe(true);
    expect(contactMatchesSearch(ada, '@ada_l')).toBe(true);
    expect(contactMatchesSearch(ada, '@ADA')).toBe(true);
  });

  it('sigue encontrando por nombre y por teléfono', () => {
    expect(contactMatchesSearch(ada, 'lovelace')).toBe(true);
    expect(contactMatchesSearch({ phone: '+14155550123' }, '4155550')).toBe(
      true
    );
  });

  it('no encuentra lo que no está', () => {
    expect(contactMatchesSearch(ada, 'babbage')).toBe(false);
  });

  it('un término vacío no filtra nada', () => {
    expect(contactMatchesSearch(ada, '   ')).toBe(true);
  });

  it('una arroba suelta no hace coincidir a todo el que tenga usuario', () => {
    expect(contactMatchesSearch(ada, '@')).toBe(false);
  });
});
