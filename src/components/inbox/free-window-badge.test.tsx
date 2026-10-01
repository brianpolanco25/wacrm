import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FreeWindowBadge } from './free-window-badge';
import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

describe('FreeWindowBadge (R18, R19)', () => {
  const html = renderToStaticMarkup(
    <FreeWindowBadge
      label="Free window until Sat 4, 12:00"
      title="Meta does not charge until Sat 4, 12:00."
    />
  );

  it('pinta el texto, el title y el gancho data-free-window', () => {
    expect(html).toContain('Free window until Sat 4, 12:00');
    expect(html).toContain('title="Meta does not charge until Sat 4, 12:00."');
    expect(html).toContain('data-free-window');
  });

  it('lleva icono además del color (nunca solo color)', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('lucide-gift');
    expect(html).toContain('text-emerald-600');
  });

  it('acepta clases extra (la cabecera la oculta en móvil)', () => {
    const header = renderToStaticMarkup(
      <FreeWindowBadge label="x" title="y" className="hidden sm:inline-flex" />
    );
    expect(header).toContain('hidden sm:inline-flex');
  });
});

describe('claves Inbox.freeWindow (R22, CP6)', () => {
  const catalogs = { en, es } as const;

  it.each(Object.entries(catalogs))(
    '%s tiene badge y tooltip con el placeholder {until}',
    (_lang, catalog) => {
      const fw = (
        catalog as unknown as {
          Inbox: { freeWindow: { badge: string; tooltip: string } };
        }
      ).Inbox.freeWindow;
      expect(Object.keys(fw).sort()).toEqual(['badge', 'tooltip']);
      expect(fw.badge).toContain('{until}');
      expect(fw.tooltip).toContain('{until}');
      expect(fw.badge.match(/\{[^}]+\}/g)).toEqual(['{until}']);
      expect(fw.tooltip.match(/\{[^}]+\}/g)).toEqual(['{until}']);
    }
  );
});
