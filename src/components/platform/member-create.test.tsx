import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import { MemberCreate, MemberCreateResult } from './member-create';
import { MEMBER_CREATE_ROLES } from './member-create-form';

// «Crear miembro» (i12.2). Static markup, like the rest of the panel (no
// jsdom): the closed button, the one-time result, and the catalogues.
// What it posts is tested on the route; the form's rules in
// member-create-form.test.ts.

type Catalogue = typeof es;

function wrap(node: React.ReactNode, messages: Catalogue, locale: string) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('MemberCreate (R26)', () => {
  it('shows only the button until it is opened, in both languages', () => {
    const el = <MemberCreate accountId="acc-1" onCreated={() => {}} />;
    const htmlEs = wrap(el, es, 'es');
    expect(htmlEs).toContain('Crear miembro');
    expect(htmlEs).not.toContain('<input');
    expect(htmlEs).not.toContain('<select');
    const htmlEn = wrap(el, en as Catalogue, 'en');
    expect(htmlEn).toContain('Create member');
    expect(htmlEn).not.toContain('<input');
  });
});

describe('the role selector (R27)', () => {
  it('offers admin, agent and viewer, each with a label — never owner', () => {
    expect([...MEMBER_CREATE_ROLES]).toEqual(['admin', 'agent', 'viewer']);
    expect(MEMBER_CREATE_ROLES).not.toContain('owner');
    for (const role of MEMBER_CREATE_ROLES) {
      expect(es.Platform.provisioning.roles[role]).toBeTruthy();
      expect(en.Platform.provisioning.roles[role]).toBeTruthy();
    }
  });
});

describe('MemberCreateResult (R28)', () => {
  it('shows the email, the password and the once-only warning', () => {
    const html = wrap(
      <MemberCreateResult
        email="ana@acme.test"
        password="Clave-Secreta-2026"
        onCopy={() => {}}
      />,
      es,
      'es'
    );
    expect(html).toContain('ana@acme.test');
    expect(html).toContain('Clave-Secreta-2026');
    expect(html).toContain('no se vuelve a mostrar');
    expect(html).toContain(es.Platform.memberCreateCopy);
  });

  it('in English too', () => {
    const html = wrap(
      <MemberCreateResult
        email="a@b.test"
        password="xyzxyzxyz"
        onCopy={() => {}}
      />,
      en as Catalogue,
      'en'
    );
    expect(html).toContain('it will not be shown again');
  });
});

describe('the catalogues (R30)', () => {
  const placeholders = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('every memberCreate* key is in both, with the same placeholders', () => {
    const esP = es.Platform as Record<string, unknown>;
    const enP = en.Platform as Record<string, unknown>;
    const esKeys = Object.keys(esP).filter((k) => k.startsWith('memberCreate'));
    const enKeys = Object.keys(enP).filter((k) => k.startsWith('memberCreate'));
    expect(esKeys.length).toBe(26);
    expect(enKeys.sort()).toEqual([...esKeys].sort());
    for (const key of esKeys) {
      expect(placeholders(enP[key] as string)).toEqual(
        placeholders(esP[key] as string)
      );
    }
  });
});
