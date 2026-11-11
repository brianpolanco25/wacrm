import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import { PlaygroundToolsNotice, ToolsUsedLine } from './ai-tools-used';

// n13.3 R35: qué herramientas usó el turno y el aviso del playground.

const CATALOGUES = { en, es } as const;

function render(node: React.ReactNode, locale: 'es' | 'en') {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale]}
    >
      {node}
    </NextIntlClientProvider>
  );
}

describe.each(['es', 'en'] as const)('[%s]', (locale) => {
  const a = CATALOGUES[locale].AiTools;

  it('lists each tool with ✓ / ✗ and an accessible label', () => {
    const html = render(
      <ToolsUsedLine
        toolsUsed={[
          { integration: 'Health', operation: 'search_patient', ok: true },
          { integration: 'Health', operation: 'create_appointment', ok: false },
        ]}
      />,
      locale
    );
    expect(html).toContain(a.used);
    expect(html).toContain('Health · search_patient ✓');
    expect(html).toContain('Health · create_appointment ✗');
    expect(html).toContain(
      `aria-label="${a.used} Health · search_patient ${a.ok}, Health · create_appointment ${a.failed}"`
    );
    expect(html).toContain('data-tool-ok="false"');
  });

  it('renders nothing for an empty list', () => {
    expect(render(<ToolsUsedLine toolsUsed={[]} />, locale)).toBe('');
  });

  it('the playground notice says tools really run', () => {
    const html = render(<PlaygroundToolsNotice />, locale);
    expect(html).toContain(a.playgroundNotice);
    expect(html).toContain('role="note"');
  });
});

describe('ToolsUsedLine — blocked by policy (n13.7, R30)', () => {
  it.each(['es', 'en'] as const)('marks a blocked call in %s', (locale) => {
    const html = render(
      <ToolsUsedLine
        toolsUsed={[
          {
            integration: 'Health',
            operation: 'cancel_appointment',
            ok: false,
            blocked: 'policy',
          },
        ]}
      />,
      locale
    );
    const blocked = (locale === 'es' ? es : en).AiTools.toolBlocked;
    expect(html).toContain('data-tool-blocked="true"');
    expect(html).toContain(`(${blocked})`);
    expect(html).toContain(`Health · cancel_appointment ${blocked}`);
  });
});
