import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import es from '../../../messages/es.json';
import { API_RELEASES } from '@/content/developers/changelog';

import { ChangelogView, changelogToc, releaseAnchor } from './changelog-view';

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="es" timeZone="UTC" messages={es}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('ChangelogView', () => {
  const html = render(<ChangelogView locale="es" />);

  it('pinta todas las versiones del archivo de contenido, con su ancla', () => {
    for (const release of API_RELEASES) {
      expect(html).toContain(`id="${releaseAnchor(release.version)}"`);
      expect(html).toContain(release.version);
      expect(html).toContain(release.date);
    }
  });

  it('pinta cada línea de cambio en el idioma leído', () => {
    for (const release of API_RELEASES) {
      expect(html).toContain(release.summary.es);
    }
  });

  it('cambia de idioma sin cambiar de versiones', () => {
    const inglés = render(<ChangelogView locale="en" />);
    for (const release of API_RELEASES) {
      expect(inglés).toContain(release.summary.en);
      expect(inglés).not.toContain(release.summary.es);
    }
  });

  it('etiqueta el tipo de cambio con el catálogo de la interfaz', () => {
    expect(html).toContain(es.Developers.changelog.added);
  });

  it('da una entrada de índice por versión', () => {
    expect(changelogToc().map((entry) => entry.id)).toEqual(
      API_RELEASES.map((release) => releaseAnchor(release.version))
    );
  });
});
