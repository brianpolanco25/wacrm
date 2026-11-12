import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import { modelSupportsVision, withoutImages } from './vision';

const img = { mimeType: 'image/jpeg' as const, data: 'QUJD' };

describe('modelSupportsVision (R22)', () => {
  it('denies known text-only models', () => {
    expect(modelSupportsVision('openai', 'gpt-3.5-turbo')).toBe(false);
    expect(modelSupportsVision('openai', 'o3-mini')).toBe(false);
    expect(modelSupportsVision('openai', 'o1-mini')).toBe(false);
    expect(modelSupportsVision('openai', 'gpt-4')).toBe(false);
    expect(modelSupportsVision('openai', 'gpt-4-0613')).toBe(false);
    expect(modelSupportsVision('anthropic', 'claude-2.1')).toBe(false);
    expect(modelSupportsVision('anthropic', 'claude-instant-1.2')).toBe(false);
  });

  it('allows everything else', () => {
    expect(modelSupportsVision('openai', 'gpt-4o-mini')).toBe(true);
    expect(modelSupportsVision('openai', 'gpt-4-turbo')).toBe(true);
    expect(modelSupportsVision('openai', 'gpt-5')).toBe(true);
    expect(modelSupportsVision('anthropic', 'claude-sonnet-4-5')).toBe(true);
    expect(modelSupportsVision('gemini', 'gemini-2.5-flash')).toBe(true);
  });
});

describe('withoutImages (R22)', () => {
  it('drops bytes, rewrites the marker keeping the caption, leaves text turns', () => {
    const input: ChatMessage[] = [
      { role: 'user', content: 'hola' },
      {
        role: 'user',
        content: '[imagen] mi cédula',
        image: { playground: true },
        images: [img],
      },
      {
        role: 'user',
        content: '[imagen]',
        image: { messageId: 'm1', mediaUrl: null, mediaType: null },
        images: [img],
      },
      { role: 'assistant', content: 'ok' },
    ];
    const snapshot = structuredClone(input);
    const out = withoutImages(input);
    expect(out).toEqual([
      { role: 'user', content: 'hola' },
      {
        role: 'user',
        content: '[imagen no disponible] mi cédula',
        image: { playground: true },
      },
      {
        role: 'user',
        content: '[imagen no disponible]',
        image: { messageId: 'm1', mediaUrl: null, mediaType: null },
      },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(out[0]).toBe(input[0]);
    expect(input).toEqual(snapshot);
    expect(out.some((m) => 'images' in m)).toBe(false);
  });
});
