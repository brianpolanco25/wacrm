import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import { VoiceTranscript } from './voice-transcript';

// n15.1 R33/R34: la transcripción bajo la burbuja de audio.

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

describe.each(['es', 'en'] as const)('[%s]', (locale) => {
  const b = CATALOGUES[locale].Inbox.bubble;

  it('done → label and text', () => {
    const html = render(
      <VoiceTranscript status="done" transcript="cita el jueves" />,
      locale
    );
    expect(html).toContain(b.transcriptLabel);
    expect(html).toContain('cita el jueves');
    expect(html).toContain('data-voice-transcript');
  });

  it('escapes markup in the transcript', () => {
    const html = render(
      <VoiceTranscript status="done" transcript="<script>alert(1)</script>" />,
      locale
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('failed and skipped → transcriptUnavailable', () => {
    for (const status of ['failed', 'skipped'] as const) {
      const html = render(
        <VoiceTranscript status={status} transcript={null} />,
        locale
      );
      expect(html).toContain(b.transcriptUnavailable);
      expect(html).not.toContain(b.transcriptLabel);
    }
  });

  it('null → nothing', () => {
    expect(
      render(<VoiceTranscript status={null} transcript={null} />, locale)
    ).toBe('');
    expect(render(<VoiceTranscript />, locale)).toBe('');
  });
});
