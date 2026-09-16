import { describe, it, expect } from 'vitest';

import { isDuplicateTagNameError } from './tag-manager';
import es from '../../../messages/es.json';
import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';

/**
 * Integración de la fase 7 — el panel frente al índice único que añade
 * la migración 064 (`tags (account_id, lower(name))`).
 *
 * Esta tarjeta inserta directo contra Supabase desde el navegador, sin
 * pasar por `/api/v1/tags`: hasta ahora podía crear «Moroso» junto a un
 * «moroso» existente. Con el índice, ese insert vuelve con 23505 y sin
 * tratarlo el agente vería «No se pudo crear la etiqueta», que es falso
 * —la etiqueta existe, solo que en otra caja— y encima invita a
 * reintentar.
 *
 * No hay jsdom ni testing-library en el repo (y no se añaden
 * dependencias), así que lo que se prueba es la rama: el clasificador
 * del error y que la clave del mensaje esté en los tres catálogos.
 */
describe('TagManager — nombre duplicado', () => {
  it('reconoce el 23505 del índice único como "ya existe"', () => {
    expect(isDuplicateTagNameError({ code: '23505' })).toBe(true);
  });

  it('no confunde otros fallos con un duplicado', () => {
    // 42501 = RLS. Ese sí es «no se pudo crear»: debe seguir cayendo en
    // el toast genérico y en el console.error, no en un mensaje que diga
    // que la etiqueta ya existe.
    expect(isDuplicateTagNameError({ code: '42501' })).toBe(false);
    expect(isDuplicateTagNameError({})).toBe(false);
    expect(isDuplicateTagNameError(null)).toBe(false);
    expect(isDuplicateTagNameError(undefined)).toBe(false);
  });

  it('tiene el mensaje en los tres catálogos (CP6)', () => {
    for (const messages of [es, en, ko]) {
      const section = (
        messages as unknown as {
          Settings: { tagsAndFields: Record<string, string> };
        }
      ).Settings.tagsAndFields;
      expect(typeof section.tagAlreadyExists).toBe('string');
      expect(section.tagAlreadyExists.length).toBeGreaterThan(0);
      // Y no es el genérico reciclado: dicen cosas distintas.
      expect(section.tagAlreadyExists).not.toBe(section.failedToCreateTag);
    }
  });
});
