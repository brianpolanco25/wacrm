import { describe, expect, it } from 'vitest';
import { fitWhatsAppText, WHATSAPP_TEXT_MAX_LENGTH } from './text-limit';

describe('fitWhatsAppText (p11.4, R3)', () => {
  it('leaves a text of exactly 4096 units unchanged', () => {
    const text = 'a'.repeat(WHATSAPP_TEXT_MAX_LENGTH);
    expect(fitWhatsAppText(text)).toEqual({
      text,
      truncated: false,
      originalLength: 4096,
    });
  });

  it('truncates 4097 units to at most 4096 ending in an ellipsis', () => {
    const out = fitWhatsAppText('a'.repeat(4097));
    expect(out.truncated).toBe(true);
    expect(out.originalLength).toBe(4097);
    expect(out.text.length).toBeLessThanOrEqual(4096);
    expect(out.text.endsWith('…')).toBe(true);
  });

  it('cuts at the last whitespace within the final 200 characters', () => {
    // 4000 'a', a space, then 200 'b': the cut falls at the space.
    const text = 'a'.repeat(4000) + ' ' + 'b'.repeat(200);
    const out = fitWhatsAppText(text);
    expect(out.text).toBe('a'.repeat(4000) + '…');
  });

  it('cuts hard when the tail has no whitespace', () => {
    const text = 'a'.repeat(3000) + ' ' + 'b'.repeat(2000);
    const out = fitWhatsAppText(text);
    expect(out.text.length).toBe(4096);
    expect(out.text).toBe(text.slice(0, 4095) + '…');
  });

  it('never splits a surrogate pair at the boundary', () => {
    // 4094 'a' + emoji (2 units) → the hard cut at 4095 would land between
    // the two halves of the emoji.
    const text = 'a'.repeat(4094) + '😀' + 'a'.repeat(10);
    const out = fitWhatsAppText(text);
    expect(out.text).toBe('a'.repeat(4094) + '…');
    const beforeEllipsis = out.text.charCodeAt(out.text.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });

  it('trims trailing whitespace before measuring', () => {
    const text = 'a'.repeat(4096) + '   \n\n';
    expect(fitWhatsAppText(text)).toEqual({
      text: 'a'.repeat(4096),
      truncated: false,
      originalLength: 4096,
    });
  });

  it('keeps line breaks of a short multi-paragraph text intact', () => {
    const text = 'Hola.\n\nPrecio: 10.\n\nGracias.';
    expect(fitWhatsAppText(text).text).toBe(text);
  });
});
