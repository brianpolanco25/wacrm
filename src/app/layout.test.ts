// Pins the product's visible name (fase 6, §1 of `progress/spec_producto.md`).
//
// The root layout is the single source of the browser tab title: Next 16
// resolves `metadata.title.default` for segments that declare no title of
// their own, and `metadata.title.template` for the ones that do. Both carry
// the brand, so a rebrand that misses one leaves half the app on the old
// name — exactly what this test catches.
//
// Two module-level dependencies of `layout.tsx` don't exist outside the
// Next compiler and are stubbed here; neither takes part in the assertions:
//   - `next/font/google`, which the SWC font loader normally rewrites into a
//     precomputed object at build time;
//   - `./globals.css`, a side-effect-only import.
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: '--font-sans', className: 'font-sans' }),
}));
vi.mock('./globals.css', () => ({}));

import { metadata } from './layout';

const BRAND = 'Cabbity CRM';

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
