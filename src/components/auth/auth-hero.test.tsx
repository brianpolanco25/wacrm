import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import es from '../../../messages/es.json';
import en from '../../../messages/en.json';

// The hero photo is a static image import; outside the Next compiler it
// resolves to nothing useful, so it is stubbed with the shape next/image
// expects from a static import.
vi.mock('@/app/(auth)/_assets/login-hero.jpg', () => ({
  default: {
    src: '/login-hero.jpg',
    width: 1122,
    height: 1402,
    blurDataURL: 'data:image/jpeg;base64,',
  },
}));

import { AuthHero, HERO_SLIDES } from './auth-hero';
import { AuthCard } from './auth-card';

type Catalogue = typeof es;

/**
 * No jsdom / testing-library in this repo, so the components render to
 * static markup — enough to pin what the storefront says and in which
 * language, which is what this redesign is accountable for.
 */
function render(node: React.ReactElement, messages: Catalogue = es) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="es" timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('AuthHero', () => {
  it('opens on the growth pitch, in Spanish by default', () => {
    const html = render(<AuthHero />);
    expect(html).toContain(es.LoginPage.hero.slides.growth.lead);
    expect(html).toContain(es.LoginPage.hero.slides.growth.accent);
    expect(html).toContain(es.LoginPage.hero.slides.growth.quote);
    expect(html).not.toContain(es.LoginPage.hero.slides.clients.lead);
  });

  it('lists the three value propositions', () => {
    const html = render(<AuthHero />);
    for (const feature of Object.values(es.LoginPage.hero.features)) {
      expect(html).toContain(feature.title);
      expect(html).toContain(feature.desc);
    }
  });

  it('shows the brand lockup with the localised tagline', () => {
    const html = render(<AuthHero />);
    expect(html).toContain('Cabbity');
    expect(html).toContain(es.LoginPage.brand.tagline);
    expect(render(<AuthHero />, en)).toContain(en.LoginPage.brand.tagline);
  });

  it('renders one indicator per slide and marks the current one', () => {
    const html = render(<AuthHero initialSlide={2} />);
    const tabs = html.match(/role="tab"/g) ?? [];
    expect(tabs).toHaveLength(HERO_SLIDES.length);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain(es.LoginPage.hero.slides.results.lead);
  });

  it('describes the photograph for assistive tech', () => {
    const html = render(<AuthHero />);
    expect(html).toContain(`alt="${es.LoginPage.hero.imageAlt}"`);
  });

  it('sits out of the flow below the desktop breakpoint', () => {
    // Phones get the card only; the lockup inside AuthCard carries the
    // brand there. If this class goes, the hero pushes the form below
    // the fold on every phone.
    const html = render(<AuthHero />);
    expect(html).toMatch(
      /data-slot="auth-hero"[^>]*class="[^"]*\bhidden\b[^"]*\blg:flex\b/
    );
  });
});

describe('AuthCard', () => {
  it('wraps the form in the brand lockup and heading', () => {
    const html = render(
      <AuthCard title="Hola" description="Entra">
        <form data-testid="f" />
      </AuthCard>
    );
    expect(html).toContain('Cabbity');
    expect(html).toContain(es.LoginPage.brand.kicker);
    expect(html).toContain('<h1');
    expect(html).toContain('Hola');
    expect(html).toContain('Entra');
    expect(html).toContain('data-testid="f"');
  });
});
