import { describe, expect, it } from 'vitest';

import { DOCS_LOCALES } from '@/content/developers/types';

import { getLegalDoc, LEGAL_ENTITY, LEGAL_SLUGS } from '.';

describe('páginas legales', () => {
  it('existen en todos los idiomas con la misma estructura', () => {
    for (const slug of LEGAL_SLUGS) {
      const [base, ...rest] = DOCS_LOCALES.map((l) => getLegalDoc(l, slug));
      for (const doc of rest) {
        expect(doc.sections).toHaveLength(base.sections.length);
        doc.sections.forEach((s, i) => {
          expect(s.paragraphs?.length ?? 0).toBe(
            base.sections[i].paragraphs?.length ?? 0
          );
          expect(s.bullets?.length ?? 0).toBe(
            base.sections[i].bullets?.length ?? 0
          );
        });
      }
    }
  });

  it('dan el correo de contacto en la política de privacidad', () => {
    for (const locale of DOCS_LOCALES) {
      const text = JSON.stringify(getLegalDoc(locale, 'privacy'));
      expect(text).toContain(LEGAL_ENTITY.email);
    }
  });

  it('declaran los permisos de Meta que pide el registro integrado', () => {
    for (const locale of DOCS_LOCALES) {
      const text = JSON.stringify(getLegalDoc(locale, 'privacy'));
      expect(text).toContain('whatsapp_business_management');
      expect(text).toContain('whatsapp_business_messaging');
    }
  });
});
