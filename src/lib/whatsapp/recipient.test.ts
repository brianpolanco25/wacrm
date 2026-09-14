import { describe, expect, it } from 'vitest';

import {
  describeRecipient,
  recipientAttempts,
  RecipientError,
  resolveRecipient,
} from './recipient';
import { isValidBsuid, sanitizeBsuid, sanitizeWaUsername } from './bsuid';

// Fase 6 §5. La regla que se fija aquí es la que siguen los cuatro
// caminos de salida (bandeja, flujos, automatizaciones, difusiones):
// teléfono si lo hay y es marcable, BSUID si no.

describe('resolveRecipient', () => {
  it('prefiere el teléfono cuando el contacto tiene las dos identidades', () => {
    expect(
      resolveRecipient({ phone: '+1 415 555 0123', wa_user_id: 'US.13497' })
    ).toEqual({ kind: 'phone', phone: '14155550123' });
  });

  it('usa el BSUID cuando no hay teléfono', () => {
    expect(resolveRecipient({ phone: null, wa_user_id: 'US.13497' })).toEqual({
      kind: 'user_id',
      userId: 'US.13497',
    });
  });

  it('cae al BSUID cuando el teléfono guardado no es marcable', () => {
    // Basura de una importación vieja: mejor entregar por BSUID que
    // fallar por formato.
    expect(resolveRecipient({ phone: '12', wa_user_id: 'US.13497' })).toEqual({
      kind: 'user_id',
      userId: 'US.13497',
    });
  });

  it('protesta con un teléfono inválido y sin BSUID', () => {
    expect(() => resolveRecipient({ phone: '12' })).toThrow(RecipientError);
  });

  it('protesta cuando el contacto no tiene ninguna identidad', () => {
    expect(() => resolveRecipient({})).toThrow(RecipientError);
  });
});

describe('recipientAttempts', () => {
  it('por teléfono, prueba las variantes de prefijo troncal', () => {
    const attempts = recipientAttempts({ kind: 'phone', phone: '37063949836' });
    expect(attempts[0]).toEqual({ to: '37063949836' });
    expect(attempts.length).toBeGreaterThan(1);
    // Ninguna variante lleva `recipient`: el teléfono va solo.
    expect(attempts.every((a) => a.recipient === undefined)).toBe(true);
  });

  it('por BSUID, un único intento — el id es exacto', () => {
    expect(recipientAttempts({ kind: 'user_id', userId: 'US.13497' })).toEqual([
      { recipient: 'US.13497' },
    ]);
  });
});

describe('describeRecipient', () => {
  it('distingue las dos identidades en los logs', () => {
    expect(describeRecipient({ kind: 'phone', phone: '1415' })).toBe('1415');
    expect(describeRecipient({ kind: 'user_id', userId: 'US.1' })).toBe(
      'user_id:US.1'
    );
  });
});

describe('sanitizeBsuid — permisivo, para lo que viene de Meta', () => {
  it('recorta y acepta el formato documentado', () => {
    expect(sanitizeBsuid('  US.1349700000000001 ')).toBe('US.1349700000000001');
  });

  it('acepta un prefijo que no encaja en el patrón documentado', () => {
    // Si Meta cambia el formato, un entrante NO se puede perder por eso
    // (CP11). Esa es toda la razón de ser de esta función.
    expect(sanitizeBsuid('XYZQ.1234')).toBe('XYZQ.1234');
  });

  it('descarta lo que no puede ser un id', () => {
    expect(sanitizeBsuid('')).toBeNull();
    expect(sanitizeBsuid('   ')).toBeNull();
    expect(sanitizeBsuid('US.1349 con espacios')).toBeNull();
    expect(sanitizeBsuid('U'.repeat(200))).toBeNull();
    expect(sanitizeBsuid(undefined)).toBeNull();
    expect(sanitizeBsuid(42)).toBeNull();
  });
});

describe('isValidBsuid — estricto, para lo que teclea un tercero', () => {
  it('acepta CC.<alfanum>', () => {
    expect(isValidBsuid('US.1349700000000001')).toBe(true);
    expect(isValidBsuid(' ES.abc123 ')).toBe(true);
  });

  it('rechaza lo que no lo es', () => {
    expect(isValidBsuid('US.')).toBe(false);
    expect(isValidBsuid('USA.123')).toBe(false);
    expect(isValidBsuid('+14155550123')).toBe(false);
    expect(isValidBsuid('US.13497-00')).toBe(false);
  });
});

describe('sanitizeWaUsername', () => {
  it('guarda el nombre de usuario sin arroba', () => {
    expect(sanitizeWaUsername('@ada')).toBe('ada');
    expect(sanitizeWaUsername('  ada  ')).toBe('ada');
  });

  it('descarta lo vacío o lo que no es un nombre de usuario', () => {
    expect(sanitizeWaUsername('@')).toBeNull();
    expect(sanitizeWaUsername('ada lovelace')).toBeNull();
    expect(sanitizeWaUsername(null)).toBeNull();
  });
});
