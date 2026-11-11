import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import {
  playgroundRequestMessages,
  SimulatedVoiceNoteLabel,
  VoiceNoteToggle,
} from './ai-voice';

// n15.1 R37: el playground simula notas de voz.

const CATALOGUES = { en, es } as const;

function render(node: React.ReactNode, locale: 'es' | 'en') {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale]}
    >
      {node}
    </NextIntlClientProvider>
  );
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe.each(['es', 'en'] as const)('[%s]', (locale) => {
  const v = CATALOGUES[locale].AiVoice;

  it('the toggle exposes aria-pressed and the sendAsVoice label', () => {
    const off = render(
      <VoiceNoteToggle pressed={false} onToggle={() => {}} />,
      locale
    );
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain(`aria-label="${escape(v.sendAsVoice)}"`);
    expect(off).toContain(`title="${escape(v.sendAsVoiceHint)}"`);
    const on = render(<VoiceNoteToggle pressed onToggle={() => {}} />, locale);
    expect(on).toContain('aria-pressed="true"');
  });

  it('a voice turn is labelled as a simulated voice note', () => {
    expect(render(<SimulatedVoiceNoteLabel />, locale)).toContain(
      v.simulatedVoiceNote
    );
  });
});

describe('playgroundRequestMessages', () => {
  it('sends voice: true only on the marked user turn', () => {
    expect(
      playgroundRequestMessages([
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'Hola', voice: true },
        { role: 'user', content: 'cita el jueves', voice: true },
      ])
    ).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'Hola' },
      { role: 'user', content: 'cita el jueves', voice: true },
    ]);
  });

  it('drops display-only fields (handoff, toolsUsed)', () => {
    const turn = {
      role: 'assistant' as const,
      content: 'x',
      handoff: true,
      toolsUsed: [],
    };
    expect(playgroundRequestMessages([turn])).toEqual([
      { role: 'assistant', content: 'x' },
    ]);
  });
});
