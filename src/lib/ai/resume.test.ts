import { describe, it, expect } from 'vitest';
import { stripHandoffNotices } from './resume';
import { DEFAULT_HANDOFF_MESSAGE } from './handoff-message';
import type { ChatMessage } from './types';

const NOTICE =
  'Gracias por escribirnos. Un miembro de nuestro equipo le estara contactando lo mas pronto posible.';

describe('stripHandoffNotices', () => {
  it('removes the configured notice and flags the thread as resumed', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Si, me gustaría agendar' },
      { role: 'assistant', content: NOTICE },
      { role: 'user', content: 'Hola' },
    ];
    const out = stripHandoffNotices(messages, NOTICE);
    expect(out.resumedAfterHandoff).toBe(true);
    expect(out.messages).toEqual([
      { role: 'user', content: 'Si, me gustaría agendar' },
      { role: 'user', content: 'Hola' },
    ]);
  });

  it('removes every notice, not just the first (repeated resumes)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Buenas' },
      { role: 'assistant', content: NOTICE },
      { role: 'user', content: 'Buenas tardes' },
      { role: 'assistant', content: NOTICE },
      { role: 'user', content: 'Me gustaría agendar' },
    ];
    const out = stripHandoffNotices(messages, NOTICE);
    expect(out.messages.every((m) => m.role === 'user')).toBe(true);
    expect(out.messages).toHaveLength(3);
  });

  it('leaves an untouched thread alone and does not flag it', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello! How can I help?' },
    ];
    const out = stripHandoffNotices(messages, NOTICE);
    expect(out).toEqual({ messages, resumedAfterHandoff: false });
  });

  it('matches regardless of surrounding whitespace and line breaks', () => {
    const wrapped = `  Gracias por escribirnos.\nUn miembro de nuestro equipo le estara contactando lo mas pronto posible. `;
    const out = stripHandoffNotices(
      [{ role: 'assistant', content: wrapped }],
      NOTICE
    );
    expect(out.messages).toEqual([]);
    expect(out.resumedAfterHandoff).toBe(true);
  });

  it('also recognises the shipped default when the account changed its message', () => {
    const out = stripHandoffNotices(
      [
        { role: 'assistant', content: DEFAULT_HANDOFF_MESSAGE },
        { role: 'user', content: 'hello?' },
      ],
      'Te paso con una persona.'
    );
    expect(out.messages).toEqual([{ role: 'user', content: 'hello?' }]);
    expect(out.resumedAfterHandoff).toBe(true);
  });

  it('never strips a customer message, even one quoting the notice', () => {
    const out = stripHandoffNotices(
      [{ role: 'user', content: NOTICE }],
      NOTICE
    );
    expect(out.messages).toEqual([{ role: 'user', content: NOTICE }]);
    expect(out.resumedAfterHandoff).toBe(false);
  });

  it('with the notice opted out (empty), only the default is a candidate', () => {
    const out = stripHandoffNotices(
      [
        { role: 'assistant', content: 'A normal reply' },
        { role: 'assistant', content: DEFAULT_HANDOFF_MESSAGE },
      ],
      ''
    );
    expect(out.messages).toEqual([
      { role: 'assistant', content: 'A normal reply' },
    ]);
    expect(out.resumedAfterHandoff).toBe(true);
  });
});
