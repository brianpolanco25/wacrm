// Pins the product's visible name (fase 6, §1 of `progress/spec_producto.md`)
// and the self-hosted font (s9.10 of `progress/spec_superadmin.md`).
//
// The root layout is the single source of the browser tab title: Next 16
// resolves `metadata.title.default` for segments that declare no title of
// their own, and `metadata.title.template` for the ones that do. Both carry
// the brand, so a rebrand that misses one leaves half the app on the old
// name — exactly what this test catches.
//
// Two module-level dependencies of `layout.tsx` don't exist outside the
// Next compiler and are stubbed here:
//   - `next/font/local`, which the SWC font loader normally rewrites into a
//     precomputed object at build time. The stub records its options so the
//     font tests below can check what the layout asks for;
//   - `./globals.css`, a side-effect-only import.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type FontSrc = { path: string; weight?: string; style?: string };
type LocalFontOptions = {
  src: FontSrc[];
  variable?: string;
  display?: string;
  preload?: boolean;
  adjustFontFallback?: string | false;
  declarations?: { prop: string; value: string }[];
};

const fontCalls = vi.hoisted(() => [] as LocalFontOptions[]);

vi.mock('next/font/local', () => ({
  default: (options: LocalFontOptions) => {
    fontCalls.push(options);
    return { variable: options.variable, className: 'font-local' };
  },
}));
vi.mock('./globals.css', () => ({}));

import { metadata } from './layout';

const BRAND = 'Cabbity CRM';
const APP_DIR = path.join(process.cwd(), 'src/app');
const SRC = path.join(process.cwd(), 'src');

describe('root metadata', () => {
  it('titles the app "Cabbity CRM" by default', () => {
    const title = metadata.title as { default: string; template: string };
    expect(title.default).toBe(BRAND);
  });

  it('appends the brand to every per-page title', () => {
    const title = metadata.title as { default: string; template: string };
    expect(title.template).toBe(`%s — ${BRAND}`);
    expect(title.template.replace('%s', 'Inbox')).toBe(`Inbox — ${BRAND}`);
  });

  it('carries no trace of the previous name', () => {
    expect(JSON.stringify(metadata)).not.toMatch(/wa\s?crm/i);
  });
});

function byVariable(variable: string): LocalFontOptions {
  const call = fontCalls.find((c) => c.variable === variable);
  if (!call) throw new Error(`no localFont call with variable ${variable}`);
  return call;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|mjs|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('self-hosted Inter (s9.10)', () => {
  it('loads the UI weights 400/500/600/700 from the repository', () => {
    const inter = byVariable('--font-inter');
    expect(inter.src.map((s) => s.weight)).toEqual([
      '400',
      '500',
      '600',
      '700',
    ]);
    expect(inter.src.every((s) => s.style === 'normal')).toBe(true);
    expect(inter.display).toBe('swap');
    expect(inter.preload).toBe(true);
    expect(inter.adjustFontFallback).toBe('Arial');
  });

  it('serves Latin Extended at 400/600 only for its unicode-range, without preload', () => {
    const ext = byVariable('--font-inter-latin-ext');
    expect(ext.src.map((s) => s.weight)).toEqual(['400', '600']);
    expect(ext.display).toBe('swap');
    expect(ext.preload).toBe(false);
    const range = ext.declarations?.find((d) => d.prop === 'unicode-range');
    expect(range?.value).toMatch(/^U\+0100-024F,/);
    // Basic Latin must stay out of the extended face, or it would shadow `inter`.
    expect(range?.value).not.toMatch(/U\+00[0-9A-F]{2}/);
  });

  it('points every src at a real woff2 file next to the OFL licence', () => {
    for (const call of fontCalls) {
      for (const { path: rel } of call.src) {
        const buf = fs.readFileSync(path.join(APP_DIR, rel));
        expect(buf.subarray(0, 4).toString('latin1'), rel).toBe('wOF2');
      }
    }
    const licence = fs.readFileSync(
      path.join(APP_DIR, 'fonts/LICENSE-Inter.txt'),
      'utf8'
    );
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(licence).toContain('The Inter Project Authors');
  });

  it('wires both families into --font-sans and --font-heading', () => {
    const css = fs.readFileSync(path.join(APP_DIR, 'globals.css'), 'utf8');
    const stack = 'var(--font-inter-latin-ext), var(--font-inter)';
    expect(css).toContain(`--font-sans: ${stack};`);
    expect(css).toContain(`--font-heading: ${stack};`);
  });

  it('leaves no Google Fonts loader anywhere in src', () => {
    // Built from pieces so this file doesn't match its own search.
    const googleLoader = ['next', 'font', 'google'].join('/');
    const offenders = walk(SRC).filter((file) =>
      fs.readFileSync(file, 'utf8').includes(googleLoader)
    );
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });
});
