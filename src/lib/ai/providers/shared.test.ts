import { describe, expect, it } from 'vitest';
import { mergeConsecutive } from './shared';
import { IMG1, IMG2 } from './images-test-support';

describe('mergeConsecutive — images (n15.2, R19)', () => {
  it('concatenates images of merged turns in order and joins text', () => {
    const out = mergeConsecutive([
      { role: 'user', content: 'a', images: [IMG1] },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c', images: [IMG2] },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'a\n\nb\n\nc', images: [IMG1, IMG2] },
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('adds no images key when no turn has images, and drops voice/image flags', () => {
    const out = mergeConsecutive([
      { role: 'user', content: 'a', voice: true },
      { role: 'user', content: 'b', image: { playground: true }, images: [] },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'a\n\nb' }]);
    expect(out[0]).not.toHaveProperty('images');
  });

  it('does not share the images array of the input', () => {
    const input = [{ role: 'user' as const, content: 'a', images: [IMG1] }];
    const out = mergeConsecutive(input);
    out[0].images!.push(IMG2);
    expect(input[0].images).toEqual([IMG1]);
  });
});
