import { describe, expect, it } from 'vitest';

import { flattenToolArgs } from './args';

// n13.3 R16: argumentos anidados del modelo → mapa plano del ejecutor.

describe('flattenToolArgs', () => {
  it('flattens nested objects with dotted names', () => {
    expect(
      flattenToolArgs({ a: { b: 1 }, consent: { accepted: true }, q: 'x' })
    ).toEqual({ 'a.b': 1, 'consent.accepted': true, q: 'x' });
  });

  it('keeps arrays and null as leaves', () => {
    expect(flattenToolArgs({ ids: [1, 2], n: null })).toEqual({
      ids: [1, 2],
      n: null,
    });
  });

  it('descends at most 4 levels', () => {
    expect(flattenToolArgs({ a: { b: { c: { d: 1 } } } })).toEqual({
      'a.b.c.d': 1,
    });
    expect(flattenToolArgs({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({
      'a.b.c.d': { e: 1 },
    });
  });

  it('a non-object argument becomes {}', () => {
    for (const v of [null, undefined, 'x', 3, true, [1, 2]]) {
      expect(flattenToolArgs(v)).toEqual({});
    }
  });

  it('ignores inherited properties and treats __proto__ as a plain name', () => {
    const parent = { inherited: 1 };
    const child = Object.create(parent) as Record<string, unknown>;
    child.own = 2;
    expect(flattenToolArgs(child)).toEqual({ own: 2 });

    const evil = JSON.parse('{"__proto__": {"polluted": true}, "q": 1}');
    const out = flattenToolArgs(evil);
    expect(Object.keys(out).sort()).toEqual(['__proto__.polluted', 'q']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
