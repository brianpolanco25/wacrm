import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import {
  AttachedImagePreview,
  ImageAttachButton,
  ImageCostHint,
  imageFileError,
  playgroundImageMessages,
  TurnImage,
  type PlaygroundImage,
} from './ai-image';

// n15.2 R35, R36, R38: imágenes de prueba en el playground.

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

const img = (n: number): PlaygroundImage => ({
  mimeType: 'image/jpeg',
  data: `DATA${n}`,
  previewUrl: `data:image/jpeg;base64,DATA${n}`,
});

describe('AiImage catalogue (R38)', () => {
  it('es and en have the same AiImage keys, all non-empty', () => {
    const keys = [
      'attach',
      'remove',
      'attached',
      'tooLarge',
      'unsupportedType',
      'costHint',
      'invalidImage',
    ];
    expect(Object.keys(es.AiImage).sort()).toEqual([...keys].sort());
    expect(Object.keys(en.AiImage).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      expect((es.AiImage as Record<string, string>)[k]).toBeTruthy();
      expect((en.AiImage as Record<string, string>)[k]).toBeTruthy();
    }
  });
});

describe.each(['es', 'en'] as const)('[%s] UI (R35, R36)', (locale) => {
  const v = CATALOGUES[locale].AiImage;

  it('the attach button accepts JPEG/PNG/WebP and is labelled', () => {
    const html = render(
      <ImageAttachButton onPick={() => {}} onError={() => {}} />,
      locale
    );
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain('type="file"');
    expect(html).toContain(`aria-label="${escape(v.attach)}"`);
    expect(html).toContain(`title="${escape(v.costHint)}"`);
  });

  it('shows the cost hint', () => {
    const html = render(<ImageCostHint />, locale);
    expect(html).toContain(escape(v.costHint));
    expect(v.costHint).toMatch(/3/);
  });

  it('previews the attached image with a remove button, and shows it in the turn', () => {
    const preview = render(
      <AttachedImagePreview image={img(1)} onRemove={() => {}} />,
      locale
    );
    expect(preview).toContain('src="data:image/jpeg;base64,DATA1"');
    expect(preview).toContain(`alt="${escape(v.attached)}"`);
    expect(preview).toContain(`aria-label="${escape(v.remove)}"`);
    expect(render(<TurnImage image={img(2)} />, locale)).toContain(
      'src="data:image/jpeg;base64,DATA2"'
    );
  });
});

describe('imageFileError (R35)', () => {
  it('accepts JPEG/PNG/WebP up to 2 MiB', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(imageFileError({ type, size: 2 * 1024 * 1024 })).toBeNull();
    }
  });

  it('rejects other types and anything over 2 MiB', () => {
    expect(imageFileError({ type: 'image/gif', size: 10 })).toBe(
      'unsupportedType'
    );
    expect(imageFileError({ type: 'application/pdf', size: 10 })).toBe(
      'unsupportedType'
    );
    expect(
      imageFileError({ type: 'image/jpeg', size: 2 * 1024 * 1024 + 1 })
    ).toBe('tooLarge');
  });
});

describe('playgroundImageMessages (R35)', () => {
  it('sends bytes only for the 3 most recent images; older ones as imageOmitted', () => {
    const out = playgroundImageMessages([
      { role: 'user', content: 'a', image: img(1) },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'b', image: img(2) },
      { role: 'user', content: '', image: img(3) },
      { role: 'user', content: 'voz', voice: true },
      { role: 'user', content: 'd', image: img(4) },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'a', imageOmitted: true },
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content: 'b',
        image: { mimeType: 'image/jpeg', data: 'DATA2' },
      },
      {
        role: 'user',
        content: '',
        image: { mimeType: 'image/jpeg', data: 'DATA3' },
      },
      { role: 'user', content: 'voz', voice: true },
      {
        role: 'user',
        content: 'd',
        image: { mimeType: 'image/jpeg', data: 'DATA4' },
      },
    ]);
    // The preview data URL is never sent.
    expect(JSON.stringify(out)).not.toContain('data:image');
  });

  it('without images it is exactly the voice body', () => {
    expect(
      playgroundImageMessages([
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'Hola', voice: true },
      ])
    ).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'Hola' },
    ]);
  });
});
