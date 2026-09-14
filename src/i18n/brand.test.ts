import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The product's visible name lives in the catalogues, not in a constant:
// every user-facing sentence that names the app is a translated string.
// A rebrand therefore only sticks if *both* shipped catalogues moved, and
// nothing is easier to miss than the one mention buried in a long hint.
//
// `Sidebar.title` is the brand lockup next to the logo — the name a user
// reads on every screen — so it is pinned by value rather than by absence.
// It is a proper noun, so it is deliberately identical in `en` and `ko`.

const MESSAGES_DIR = join(process.cwd(), 'messages');
const LOCALES = ['en', 'ko'] as const;
const BRAND = 'Cabbity CRM';
/** Matches `wacrm`, `WaCRM`, `wa crm`… — the names this release retires. */
const RETIRED = /wa\s?crm/i;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8')
  ) as Record<string, unknown>;
}

function entries(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return Object.entries(node).flatMap(([k, v]) =>
      entries(v, path ? `${path}.${k}` : k)
    );
  }
  return [];
}

describe.each(LOCALES)('brand in messages/%s.json', (locale) => {
  const catalogue = load(locale);

  it('names the sidebar after the product', () => {
    expect((catalogue.Sidebar as { title: string }).title).toBe(BRAND);
  });

  it('mentions no retired product name', () => {
    const offenders = entries(catalogue)
      .filter(([, value]) => RETIRED.test(value))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it('spells the brand the same way everywhere it appears', () => {
    const mentions = entries(catalogue).filter(([, v]) => /cabbity/i.test(v));
    expect(mentions.length).toBeGreaterThan(0);
    for (const [key, value] of mentions) {
      expect(value, key).toContain(BRAND);
    }
  });
});
