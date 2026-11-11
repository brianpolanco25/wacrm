import { describe, expect, it } from 'vitest';

import {
  formatToolsUsed,
  readToolsUsed,
  readTrail,
  trailFromToolsUsed,
} from './tools-used';

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

// n13.7 R32: el trail del playground.
describe('readTrail / trailFromToolsUsed (R32)', () => {
  it('keeps well-formed ok entries, in order', () => {
    expect(
      readTrail([
        { slug: 'cabbity-health', operation: 'list_appointments', ok: true },
        { slug: 'cabbity-health', operation: 'find_availability', ok: false },
        {
          slug: 'cabbity-health',
          operation: 'cancel',
          ok: true,
          blocked: 'policy',
        },
        { operation: 'x', ok: true },
        'junk',
        null,
        { slug: 'cabbity-health', operation: 'find_availability', ok: true },
      ])
    ).toEqual([
      { integrationSlug: 'cabbity-health', operationKey: 'list_appointments' },
      { integrationSlug: 'cabbity-health', operationKey: 'find_availability' },
    ]);
  });

  it('not a list → []; more than 50 → the last 50', () => {
    expect(readTrail({ slug: 'a' })).toEqual([]);
    expect(readTrail(undefined)).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => ({
      slug: 's',
      operation: `op_${i}`,
      ok: true,
    }));
    const out = readTrail(many);
    expect(out).toHaveLength(50);
    expect(out[0].operationKey).toBe('op_10');
    expect(out[49].operationKey).toBe('op_59');
  });

  it('trailFromToolsUsed: only ok, not blocked, with slug', () => {
    expect(
      trailFromToolsUsed([
        { integration: 'H', operation: 'a', ok: true, slug: 'h' },
        { integration: 'H', operation: 'b', ok: false, slug: 'h' },
        {
          integration: 'H',
          operation: 'c',
          ok: false,
          slug: 'h',
          blocked: 'policy',
        },
        { integration: 'H', operation: 'd', ok: true },
      ])
    ).toEqual([{ slug: 'h', operation: 'a', ok: true }]);
    expect(trailFromToolsUsed(undefined)).toEqual([]);
  });
});
