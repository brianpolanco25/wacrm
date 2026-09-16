import { describe, expect, it } from 'vitest';

import { csvCell, csvRow, looksLikeFormula, toCsv } from './csv';

describe('csvCell — escape RFC 4180', () => {
  it('deja intacto lo que no necesita comillas', () => {
    expect(csvCell('hola')).toBe('hola');
    expect(csvCell(42)).toBe('42');
  });

  it('entrecomilla las comas', () => {
    expect(csvCell('uno, dos')).toBe('"uno, dos"');
  });

  it('entrecomilla y duplica las comillas dobles', () => {
    expect(csvCell('dijo "hola"')).toBe('"dijo ""hola"""');
  });

  it('entrecomilla los saltos de línea (LF y CRLF)', () => {
    expect(csvCell('uno\ndos')).toBe('"uno\ndos"');
    expect(csvCell('uno\r\ndos')).toBe('"uno\r\ndos"');
  });

  it('null y undefined son celda vacía, no la cadena "null"', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('csvCell — inyección de fórmulas (CWE-1236)', () => {
  it.each(['=', '+', '-', '@'])(
    'neutraliza la celda que empieza por %s',
    (starter) => {
      expect(csvCell(`${starter}cmd`)).toBe(`'${starter}cmd`);
    }
  );

  it('el caso de la spec: =1+1 sale como texto', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  it('también tras un tabulador o un retorno de carro iniciales', () => {
    expect(looksLikeFormula('\t=1+1')).toBe(true);
    expect(looksLikeFormula('\r=1+1')).toBe(true);
  });

  it('el prefijo va DENTRO de las comillas cuando la celda las necesita', () => {
    // Si el apóstrofo quedara fuera (`'"..."`) el archivo dejaría de ser
    // CSV válido: la celda empezaría por un carácter suelto.
    expect(csvCell('=SUM(A1,A2)')).toBe('"\'=SUM(A1,A2)"');
  });

  it('no toca lo que no parece fórmula', () => {
    expect(looksLikeFormula('hola')).toBe(false);
    expect(looksLikeFormula('')).toBe(false);
    expect(csvCell('1+1')).toBe('1+1');
  });
});

describe('csvRow / toCsv', () => {
  it('une las celdas con comas', () => {
    expect(csvRow(['a', 'b, c', null])).toBe('a,"b, c",');
  });

  it('documento completo: cabecera, CRLF y salto final', () => {
    const out = toCsv(['id', 'text'] as const, [
      { id: '1', text: 'hola' },
      { id: '2', text: 'con "comillas"' },
    ]);
    expect(out).toBe('id,text\r\n1,hola\r\n2,"con ""comillas"""\r\n');
  });

  it('una columna que falte en la fila sale vacía y no desplaza el resto', () => {
    const out = toCsv(['id', 'media_url', 'text'] as const, [
      { id: '1', text: 'hola' } as {
        id: string;
        media_url?: string;
        text: string;
      },
    ]);
    expect(out.split('\r\n')[1]).toBe('1,,hola');
  });
});
