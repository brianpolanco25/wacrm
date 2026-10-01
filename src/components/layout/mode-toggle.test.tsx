import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

/**
 * s9.11: `PlatformFrame` server-renders the mode toggle, and the client
 * knows the real mode (from the boot script) before hydrating. The
 * first render must therefore not depend on the mode at all, or React
 * reports a hydration mismatch in dark mode. Static markup, no jsdom
 * (vitest runs in `node`), same approach as `platform-shell.test.tsx`.
 */

let mode: 'light' | 'dark' = 'dark';
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ mode, toggleMode: vi.fn() }),
}));

import { ModeToggle, ModeToggleButton } from './mode-toggle';

type Catalogue = typeof es;

function render(
  node: React.ReactNode,
  locale: 'es' | 'en' = 'es',
  messages: Catalogue = es,
  fn: typeof renderToString = renderToStaticMarkup
): string {
  return fn(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

const label = (html: string) => html.match(/aria-label="([^"]+)"/)?.[1];

describe('ModeToggle — first render matches the server', () => {
  it('renders the same HTML in dark and in light mode before mounting', () => {
    mode = 'dark';
    const dark = render(<ModeToggle />, 'es', es, renderToString);
    mode = 'light';
    const light = render(<ModeToggle />, 'es', es, renderToString);
    expect(dark).toBe(light);
    expect(label(dark)).toBe('Cambiar modo');
    expect(dark).toContain('lucide-sun');
    expect(dark).not.toContain('lucide-moon');
    expect(dark).toContain('h-10 w-10');
  });

  it('uses a generic, translated label in en too', () => {
    mode = 'dark';
    const html = render(<ModeToggle />, 'en', en as Catalogue);
    expect(label(html)).toBe('Toggle mode');
  });
});

describe('ModeToggleButton — once mounted', () => {
  it('shows the moon and offers light in dark mode', () => {
    const html = render(
      <ModeToggleButton mode="dark" mounted onToggle={() => {}} />,
      'en',
      en as Catalogue
    );
    expect(html).toContain('lucide-moon');
    expect(html).not.toContain('lucide-sun');
    expect(label(html)).toBe('Switch to light mode');
  });

  it('shows the sun and offers dark in light mode', () => {
    const html = render(
      <ModeToggleButton mode="light" mounted onToggle={() => {}} />
    );
    expect(html).toContain('lucide-sun');
    expect(label(html)).toBe('Cambiar al modo dark');
  });

  it('keeps the same 40x40 button before and after mounting', () => {
    const cls = (html: string) => html.match(/class="([^"]+)"/)?.[1];
    const before = render(
      <ModeToggleButton mode="dark" mounted={false} onToggle={() => {}} />
    );
    const after = render(
      <ModeToggleButton mode="dark" mounted onToggle={() => {}} />
    );
    expect(cls(before)).toBe(cls(after));
  });
});
