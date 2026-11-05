import { describe, expect, it } from 'vitest';

import { formatToolsUsed, readToolsUsed } from './tools-used';

// n13.3 R35/R36: lo que el playground y el compositor leen de `toolsUsed`.

describe('formatToolsUsed (R36, toast of the composer)', () => {
  it('formats a valid list', () => {
    expect(
      formatToolsUsed([
        { integration: 'Health', operation: 'search', ok: true },
        { integration: 'Health', operation: 'list', ok: false },
      ])
    ).toBe('Health · search, Health · list');
  });

  it('drops malformed entries', () => {
    expect(
      formatToolsUsed([
        null,
        'Health · x',
        { integration: 'Health', operation: 7, ok: true },
        { integration: 'Health', operation: 'search' },
        { integration: 'Health', operation: 'search', ok: true },
      ])
    ).toBe('Health · search');
  });

  it.each([[[]], [undefined], [null], ['x'], [{ integration: 'H' }]])(
    'empty / not an array → "" (no toast): %j',
    (raw) => {
      expect(formatToolsUsed(raw)).toBe('');
    }
  );
});

describe('readToolsUsed (R35, playground)', () => {
  it('keeps well-formed records and returns undefined for a non-array', () => {
    expect(
      readToolsUsed([{ integration: 'H', operation: 'o', ok: false }, 3])
    ).toEqual([{ integration: 'H', operation: 'o', ok: false }]);
    expect(readToolsUsed(undefined)).toBeUndefined();
  });
});
