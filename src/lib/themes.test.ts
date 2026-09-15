import { describe, expect, it } from 'vitest';
import {
  LEGACY_THEME_IDS,
  THEMES,
  THEME_IDS,
  isThemeId,
  normalizeThemeId,
} from './themes';

// The accent catalogue carries the brand: the corporate orange ships as
// the "Cabbity" theme, and the id it replaced keeps resolving so a saved
// preference survives the rename instead of snapping back to the default.

const BRAND_ORANGE = '#f2a81b';

describe('theme catalogue', () => {
  it('offers the brand accent under the brand name', () => {
    const cabbity = THEMES.find((t) => t.id === 'cabbity');
    expect(cabbity?.name).toBe('Cabbity');
    expect(cabbity?.swatch.toLowerCase()).toBe(BRAND_ORANGE);
    expect(THEME_IDS).toContain('cabbity');
  });

  it('no longer lists a generic amber accent', () => {
    expect(THEME_IDS).not.toContain('amber');
    expect(THEMES.map((t) => t.name.toLowerCase())).not.toContain('amber');
  });

  it('has one catalogue entry per id, in order', () => {
    expect(THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
  });
});

describe('normalizeThemeId', () => {
  it('keeps a current id', () => {
    for (const id of THEME_IDS) expect(normalizeThemeId(id)).toBe(id);
  });

  it('maps the retired amber id to the brand accent', () => {
    expect(LEGACY_THEME_IDS.amber).toBe('cabbity');
    expect(normalizeThemeId('amber')).toBe('cabbity');
    expect(isThemeId('amber')).toBe(false);
  });

  it('rejects anything else', () => {
    expect(normalizeThemeId('neon')).toBeNull();
    expect(normalizeThemeId(null)).toBeNull();
    expect(normalizeThemeId(42)).toBeNull();
  });
});
